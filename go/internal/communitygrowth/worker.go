package communitygrowth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"strings"
)

type Worker struct {
	Service   *Service
	Forum     *community.Service
	BatchSize int
}
type reactionCursor struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Account string `json:"account"`
}

// Step applies one bounded page and persists its cursor in the same transaction.
// The caller controls the interval between completed full scans.
func (w *Worker) Step(ctx context.Context) (Object, error) {
	if w == nil || w.Service == nil || w.Service.Pool == nil || w.Forum == nil || w.Forum.Endpoint != w.Service.Endpoint {
		return nil, fault.New("community_growth_source_unavailable", 503)
	}
	s := w.Service
	limit := w.BatchSize
	if limit == 0 {
		limit = 100
	}
	if limit < 1 || limit > 500 {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		_, e := tx.Exec(ctx, `INSERT INTO community_growth_reconcile_state_v1(endpoint,phase,cursor,updated_at) VALUES($1,'content','',$2) ON CONFLICT(endpoint) DO NOTHING`, s.Endpoint, s.now())
		if e != nil {
			return nil, e
		}
		var phase, cursor string
		if e = tx.QueryRow(ctx, `SELECT phase,cursor FROM community_growth_reconcile_state_v1 WHERE endpoint=$1 FOR UPDATE`, s.Endpoint).Scan(&phase, &cursor); e != nil {
			return nil, e
		}
		var kind, id, dirtyCursor string
		var generation int64
		e = tx.QueryRow(ctx, `SELECT kind,object_id::text,generation,cursor FROM community_growth_dirty_objects_v1 WHERE endpoint=$1 ORDER BY updated_at,kind,object_id LIMIT 1`, s.Endpoint).Scan(&kind, &id, &generation, &dirtyCursor)
		if e == nil {
			n, done, e := w.dirtyPage(ctx, tx, kind, id, dirtyCursor, generation, limit)
			if e != nil {
				return nil, e
			}
			return Object{"phase": "dirty", "scanned": n, "objectComplete": done, "cycleComplete": false}, nil
		}
		if !noRows(e) {
			return nil, e
		}
		if phase == "content" {
			c := backfillCursor{}
			if cursor != "" {
				raw, e := base64.RawURLEncoding.DecodeString(cursor)
				if e != nil || json.Unmarshal(raw, &c) != nil {
					return nil, invalid()
				}
			}
			page, e := s.reconcilePublicSourcesWithin(ctx, tx, w.Forum, limit, c)
			if e != nil {
				return nil, e
			}
			next, _ := page["nextAfter"].(string)
			if next == "" {
				phase = "reactions"
			}
			_, e = tx.Exec(ctx, `UPDATE community_growth_reconcile_state_v1 SET phase=$2,cursor=$3,updated_at=$4 WHERE endpoint=$1`, s.Endpoint, phase, next, s.now())
			if e != nil {
				return nil, e
			}
			return Object{"phase": "content", "scanned": page["scanned"], "cycleComplete": false}, nil
		}
		if phase != "reactions" {
			return nil, invalid()
		}
		c := reactionCursor{}
		if cursor != "" {
			raw, e := base64.RawURLEncoding.DecodeString(cursor)
			if e != nil || json.Unmarshal(raw, &c) != nil {
				return nil, invalid()
			}
		}
		rows, e := tx.Query(ctx, `SELECT kind,object_id,account_id FROM (SELECT kind,object_id::text object_id,account_id::text account_id FROM forum_reactions_v1 r WHERE EXISTS (SELECT 1 FROM community_accounts a WHERE a.id=r.account_id AND a.endpoint=$1) UNION SELECT split_part(source_id,':',1),split_part(source_id,':',2),split_part(source_id,':',3) FROM community_growth_sources_v1 WHERE endpoint=$1 AND source_kind='like' AND rule_key='like_received' AND source_id ~ '^(post|reply):[0-9a-fA-F-]{36}:[0-9a-fA-F-]{36}$') r WHERE ($2='' OR (kind,object_id,account_id)>($2,$3,$4)) ORDER BY kind,object_id,account_id LIMIT $5`, s.Endpoint, c.Kind, c.ID, c.Account, limit+1)
		if e != nil {
			return nil, e
		}
		items := []reactionCursor{}
		for rows.Next() {
			var x reactionCursor
			if e = rows.Scan(&x.Kind, &x.ID, &x.Account); e != nil {
				rows.Close()
				return nil, e
			}
			items = append(items, x)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		more := len(items) > limit
		if more {
			items = items[:limit]
		}
		for _, x := range items {
			if e = s.ReconcileReactionWithin(ctx, tx, w.Forum, community.ReactionChange{Kind: x.Kind, ID: x.ID, AccountID: x.Account}); e != nil {
				return nil, e
			}
		}
		next := ""
		if more {
			raw, _ := json.Marshal(items[len(items)-1])
			next = base64.RawURLEncoding.EncodeToString(raw)
		} else {
			phase = "content"
		}
		_, e = tx.Exec(ctx, `UPDATE community_growth_reconcile_state_v1 SET phase=$2,cursor=$3,updated_at=$4,completed_at=CASE WHEN $5 THEN $4 ELSE completed_at END WHERE endpoint=$1`, s.Endpoint, phase, next, s.now(), !more)
		if e != nil {
			return nil, e
		}
		return Object{"phase": "reactions", "scanned": len(items), "cycleComplete": !more}, nil
	})
}

func (w *Worker) dirtyPage(ctx context.Context, tx pgx.Tx, kind, id, cursor string, generation int64, limit int) (int, bool, error) {
	s := w.Service
	if cursor == "" {
		if _, e := s.ReconcilePublicSourceWithin(ctx, tx, w.Forum, kind, id); e != nil {
			return 0, false, e
		}
	}
	stage, after := "r", ""
	if cursor != "" {
		parts := strings.SplitN(cursor, ":", 2)
		if len(parts) != 2 || (parts[0] != "r" && parts[0] != "p") {
			return 0, false, invalid()
		}
		stage, after = parts[0], parts[1]
	}
	if stage == "r" {
		rows, e := tx.Query(ctx, `SELECT account_id::text FROM forum_reactions_v1 WHERE kind=$1 AND object_id=$2 AND ($3='' OR account_id::text>$3) ORDER BY account_id::text LIMIT $4`, kind, id, after, limit+1)
		if e != nil {
			return 0, false, e
		}
		ids := []string{}
		for rows.Next() {
			var a string
			if e = rows.Scan(&a); e != nil {
				rows.Close()
				return 0, false, e
			}
			ids = append(ids, a)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return 0, false, e
		}
		more := len(ids) > limit
		if more {
			ids = ids[:limit]
		}
		for _, a := range ids {
			if e = s.ReconcileReactionWithin(ctx, tx, w.Forum, community.ReactionChange{Kind: kind, ID: id, AccountID: a}); e != nil {
				return 0, false, e
			}
		}
		next := ""
		if more {
			next = "r:" + ids[len(ids)-1]
		} else if kind == "post" {
			next = "p:"
		}
		if next == "" {
			_, e = tx.Exec(ctx, `DELETE FROM community_growth_dirty_objects_v1 WHERE endpoint=$1 AND kind=$2 AND object_id=$3 AND generation=$4`, s.Endpoint, kind, id, generation)
			return len(ids), true, e
		}
		_, e = tx.Exec(ctx, `UPDATE community_growth_dirty_objects_v1 SET cursor=$5 WHERE endpoint=$1 AND kind=$2 AND object_id=$3 AND generation=$4`, s.Endpoint, kind, id, generation, next)
		return len(ids), false, e
	}
	rows, e := tx.Query(ctx, `SELECT id::text FROM forum_replies_v1 WHERE post_id=$1 AND ($2='' OR id::text>$2) ORDER BY id::text LIMIT $3`, id, after, limit+1)
	if e != nil {
		return 0, false, e
	}
	ids := []string{}
	for rows.Next() {
		var reply string
		if e = rows.Scan(&reply); e != nil {
			rows.Close()
			return 0, false, e
		}
		ids = append(ids, reply)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return 0, false, e
	}
	more := len(ids) > limit
	if more {
		ids = ids[:limit]
	}
	for _, reply := range ids {
		if e = s.MarkContentChangedWithin(ctx, tx, "reply", reply); e != nil {
			return 0, false, e
		}
	}
	if more {
		_, e = tx.Exec(ctx, `UPDATE community_growth_dirty_objects_v1 SET cursor=$5 WHERE endpoint=$1 AND kind=$2 AND object_id=$3 AND generation=$4`, s.Endpoint, kind, id, generation, "p:"+ids[len(ids)-1])
		return len(ids), false, e
	}
	_, e = tx.Exec(ctx, `DELETE FROM community_growth_dirty_objects_v1 WHERE endpoint=$1 AND kind=$2 AND object_id=$3 AND generation=$4`, s.Endpoint, kind, id, generation)
	return len(ids), true, e
}
