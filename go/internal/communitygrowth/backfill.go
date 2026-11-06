package communitygrowth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

type backfillCursor struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// ReconcilePublicSources scans source IDs in stable order, including withdrawn
// records, so a later pass also removes stale projected eligibility.
func (s *Service) ReconcilePublicSources(ctx context.Context, forum *community.Service, limit int, after string) (Object, error) {
	if forum == nil || forum.Endpoint != s.Endpoint || s.Pool == nil {
		return nil, fault.New("community_growth_source_unavailable", 503)
	}
	if limit == 0 {
		limit = 100
	}
	if limit < 1 || limit > 500 {
		return nil, invalid()
	}
	c := backfillCursor{}
	if after != "" {
		raw, e := base64.RawURLEncoding.DecodeString(after)
		if e != nil || json.Unmarshal(raw, &c) != nil || (c.Kind != "post" && c.Kind != "reply") {
			return nil, invalid()
		}
		if _, e = uuid.Parse(c.ID); e != nil {
			return nil, invalid()
		}
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		return s.reconcilePublicSourcesWithin(ctx, tx, forum, limit, c)
	})
}

func (s *Service) reconcilePublicSourcesWithin(ctx context.Context, tx pgx.Tx, forum *community.Service, limit int, c backfillCursor) (Object, error) {
	rows, e := tx.Query(ctx, `SELECT kind,id FROM (SELECT 'post'::text kind,p.id::text id FROM forum_posts_v1 p JOIN community_accounts a ON a.id=p.account_id WHERE a.endpoint=$1 UNION SELECT 'reply',r.id::text FROM forum_replies_v1 r JOIN community_accounts a ON a.id=r.account_id WHERE a.endpoint=$1 UNION SELECT source_kind,source_id FROM community_growth_sources_v1 WHERE endpoint=$1 AND source_kind IN ('post','reply') AND source_kind=rule_key) sources WHERE ($2='' OR (kind,id)>($2,$3)) ORDER BY kind,id LIMIT $4`, s.Endpoint, c.Kind, c.ID, limit+1)
	if e != nil {
		return nil, e
	}
	items := []backfillCursor{}
	for rows.Next() {
		var x backfillCursor
		if e = rows.Scan(&x.Kind, &x.ID); e != nil {
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
	active := 0
	for _, x := range items {
		ok, e := s.ReconcilePublicSourceWithin(ctx, tx, forum, x.Kind, x.ID)
		if e != nil {
			return nil, e
		}
		if ok {
			active++
		}
	}
	var next any
	if more {
		raw, _ := json.Marshal(items[len(items)-1])
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	return Object{"scanned": len(items), "eligible": active, "nextAfter": next}, nil
}

// ReconcilePublicSourceWithin is also the live content-change adapter. The
// originating object is locked before the projection lock to serialize it with
// the normal forum write transaction.
func (s *Service) ReconcilePublicSourceWithin(ctx context.Context, tx pgx.Tx, forum *community.Service, kind, id string) (bool, error) {
	if forum == nil || forum.Endpoint != s.Endpoint || (kind != "post" && kind != "reply") {
		return false, invalid()
	}
	if _, e := uuid.Parse(id); e != nil {
		return false, invalid()
	}
	var account *string
	var at time.Time
	q := `SELECT account_id::text,created_at FROM forum_posts_v1 WHERE id=$1 FOR SHARE`
	if kind == "reply" {
		q = `SELECT account_id::text,created_at FROM forum_replies_v1 WHERE id=$1 FOR SHARE`
	}
	e := tx.QueryRow(ctx, q, id).Scan(&account, &at)
	missing := noRows(e)
	if e != nil && !missing {
		return false, e
	}
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912769))`, s.Endpoint+":"+kind+":"+id); e != nil {
		return false, e
	}
	var view Object
	if !missing {
		view, e = s.ReadEligibleWithin(ctx, tx, kind, id)
	}
	if !missing && e != nil {
		return false, e
	}
	eligible := !missing && view != nil && account != nil && str(view, "authorAccountId") == *account
	if kind == "reply" && str(view, "parentAvailability") != "available" {
		eligible = false
	}
	if eligible {
		var belongs bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)`, *account, s.Endpoint).Scan(&belongs)
		if e != nil {
			return false, e
		}
		eligible = belongs
	}
	rows, e := tx.Query(ctx, `SELECT account_id::text,domains,title,object_kind,object_id,active,revision,occurred_at FROM community_growth_sources_v1 WHERE endpoint=$1 AND source_kind=$2 AND source_id=$3 AND rule_key=$2 FOR UPDATE`, s.Endpoint, kind, id)
	if e != nil {
		return false, e
	}
	var old []Source
	for rows.Next() {
		var x Source
		x.Kind = kind
		x.ID = id
		x.RuleKey = kind
		if e = rows.Scan(&x.AccountID, &x.Domains, &x.Title, &x.ObjectKind, &x.ObjectID, &x.Active, &x.Revision, &x.OccurredAt); e != nil {
			rows.Close()
			return false, e
		}
		old = append(old, x)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return false, e
	}
	var existing *Source
	for i := range old {
		x := &old[i]
		if eligible && x.AccountID == *account {
			existing = x
			continue
		}
		if x.Active {
			x.Active = false
			x.Revision++
			if e = s.RecordSourceWithin(ctx, tx, *x); e != nil {
				return false, e
			}
		}
	}
	if !eligible {
		return false, nil
	}
	title := ""
	if p, ok := view["payload"].(map[string]any); ok && kind == "post" {
		title = str(p, "title")
	}
	domains := []string{}
	if topic := str(view, "topic"); topic != "" && topic != "unclassified" {
		domains = append(domains, topic)
	}
	x := Source{Kind: kind, ID: id, RuleKey: kind, AccountID: *account, Domains: domains, Title: title, ObjectKind: kind, ObjectID: id, Active: true, Revision: 1, OccurredAt: at}
	if existing != nil {
		x.Revision = existing.Revision
		if existing.Active != x.Active || existing.Title != x.Title || existing.ObjectKind != x.ObjectKind || existing.ObjectID != x.ObjectID || jsonText(existing.Domains) != jsonText(x.Domains) || !existing.OccurredAt.Equal(x.OccurredAt) {
			x.Revision++
		}
	}
	if e = s.RecordSourceWithin(ctx, tx, x); e != nil {
		return false, e
	}
	return true, nil
}
