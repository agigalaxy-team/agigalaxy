package communitygrowth

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

// ReactionSourceID identifies one real account/object relationship, not an
// invented count or a Gorse feedback identifier.
func ReactionSourceID(kind, id, account string) string { return kind + ":" + id + ":" + account }

// ReconcileReactionWithin rereads current facts under a projection-specific
// lock. Relation revision and source revision are intentionally independent.
func (s *Service) ReconcileReactionWithin(ctx context.Context, tx pgx.Tx, forum *community.Service, change community.ReactionChange) error {
	if e := s.reconcileReceivedReactionWithin(ctx, tx, forum, change); e != nil {
		return e
	}
	return s.RecordEvaluationWithin(ctx, tx, forum, change)
}
func (s *Service) reconcileReceivedReactionWithin(ctx context.Context, tx pgx.Tx, forum *community.Service, change community.ReactionChange) error {
	kind, id, actor := change.Kind, change.ID, change.AccountID
	if forum == nil || forum.Endpoint != s.Endpoint || (kind != "post" && kind != "reply") {
		return invalid()
	}
	if _, e := uuid.Parse(id); e != nil {
		return invalid()
	}
	if _, e := uuid.Parse(actor); e != nil {
		return invalid()
	}
	sourceID := ReactionSourceID(kind, id, actor)
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912770))`, s.Endpoint+":"+sourceID); e != nil {
		return e
	}
	var liked bool
	var at time.Time
	e := tx.QueryRow(ctx, `SELECT liked,updated_at FROM forum_reactions_v1 WHERE account_id=$1 AND kind=$2 AND object_id=$3`, actor, kind, id).Scan(&liked, &at)
	missing := noRows(e)
	if e != nil && !missing {
		return e
	}
	var view Object
	if !missing && liked {
		view, e = s.ReadEligibleWithin(ctx, tx, kind, id)
		if e != nil {
			return e
		}
	}
	author := ""
	title := ""
	domains := []string{}
	if view != nil {
		author = str(view, "authorAccountId")
		if p, ok := view["payload"].(map[string]any); ok && kind == "post" {
			title = str(p, "title")
		}
		if topic := str(view, "topic"); topic != "" && topic != "unclassified" {
			domains = append(domains, topic)
		}
	}
	if author != "" {
		var actual *string
		q := `SELECT account_id::text FROM forum_posts_v1 WHERE id=$1`
		if kind == "reply" {
			q = `SELECT account_id::text FROM forum_replies_v1 WHERE id=$1`
		}
		e = tx.QueryRow(ctx, q, id).Scan(&actual)
		if noRows(e) {
			author = ""
		} else if e != nil {
			return e
		} else if actual == nil || *actual != author {
			author = ""
		}
	}
	rows, e := tx.Query(ctx, `SELECT account_id::text,domains,title,object_kind,object_id,active,revision,occurred_at FROM community_growth_sources_v1 WHERE endpoint=$1 AND source_kind='like' AND rule_key='like_received' AND source_id=$2 FOR UPDATE`, s.Endpoint, sourceID)
	if e != nil {
		return e
	}
	old := []Source{}
	for rows.Next() {
		x := Source{Kind: "like", ID: sourceID, RuleKey: "like_received"}
		if e = rows.Scan(&x.AccountID, &x.Domains, &x.Title, &x.ObjectKind, &x.ObjectID, &x.Active, &x.Revision, &x.OccurredAt); e != nil {
			rows.Close()
			return e
		}
		old = append(old, x)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	var current *Source
	for i := range old {
		x := &old[i]
		if author != "" && x.AccountID == author {
			current = x
			continue
		}
		if x.Active {
			x.Active = false
			x.Revision++
			if e = s.RecordSourceWithin(ctx, tx, *x); e != nil {
				return e
			}
		}
	}
	if author == "" {
		return nil
	}
	x := Source{Kind: "like", ID: sourceID, RuleKey: "like_received", AccountID: author, Domains: domains, Title: title, ObjectKind: kind, ObjectID: id, Active: true, Revision: 1, OccurredAt: at}
	if current != nil {
		x.Revision = current.Revision
		if current.Active && current.OccurredAt.Equal(at) && current.Title == title && current.ObjectKind == kind && current.ObjectID == id && jsonText(current.Domains) == jsonText(domains) {
			return nil
		}
		x.Revision++
	}
	return s.RecordSourceWithin(ctx, tx, x)
}

func (s *Service) MarkContentChangedWithin(ctx context.Context, tx pgx.Tx, kind, id string) error {
	if kind != "post" && kind != "reply" {
		return invalid()
	}
	if _, e := uuid.Parse(id); e != nil {
		return invalid()
	}
	_, e := tx.Exec(ctx, `INSERT INTO community_growth_dirty_objects_v1(endpoint,kind,object_id,generation,cursor,updated_at) VALUES($1,$2,$3,1,'',$4) ON CONFLICT(endpoint,kind,object_id) DO UPDATE SET generation=community_growth_dirty_objects_v1.generation+1,cursor='',updated_at=excluded.updated_at`, s.Endpoint, kind, id, s.now())
	return e
}
