package communitygrowth

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RecordEvaluationWithin derives a single evaluator's current like from the
// originating relation. It is private assessment material, never an award or
// evidence that an evaluator is correct.
func (s *Service) RecordEvaluationWithin(ctx context.Context, tx pgx.Tx, forum *community.Service, change community.ReactionChange) error {
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
	var previous Source
	previous.Kind = "evaluation"
	previous.RuleKey = "evaluation"
	previous.ID = sourceID
	previous.AccountID = actor
	e = tx.QueryRow(ctx, `SELECT domains,title,object_kind,object_id,active,revision,occurred_at FROM community_growth_sources_v1 WHERE endpoint=$1 AND source_kind='evaluation' AND source_id=$2 AND rule_key='evaluation' AND account_id=$3 FOR UPDATE`, s.Endpoint, sourceID, actor).Scan(&previous.Domains, &previous.Title, &previous.ObjectKind, &previous.ObjectID, &previous.Active, &previous.Revision, &previous.OccurredAt)
	found := !noRows(e)
	if e != nil && !noRows(e) {
		return e
	}
	var view Object
	if !missing && liked {
		view, e = s.ReadEligibleWithin(ctx, tx, kind, id)
		if e != nil {
			return e
		}
	}
	active := !missing && liked && view != nil
	if !active && !found {
		return nil
	}
	if !active {
		if !previous.Active {
			return nil
		}
		previous.Active = false
		previous.Revision++
		return s.RecordSourceWithin(ctx, tx, previous)
	}
	domains := []string{}
	if topic := str(view, "topic"); topic != "" && topic != "unclassified" {
		domains = append(domains, topic)
	}
	x := Source{Kind: "evaluation", RuleKey: "evaluation", ID: sourceID, AccountID: actor, ObjectKind: kind, ObjectID: id, Domains: domains, Active: true, Revision: 1, OccurredAt: at}
	if found {
		x.Revision = previous.Revision
		if previous.Active && previous.OccurredAt.Equal(at) && previous.ObjectKind == kind && previous.ObjectID == id && previous.Title == "" && jsonText(previous.Domains) == jsonText(domains) {
			return nil
		}
		x.Revision++
	}
	return s.RecordSourceWithin(ctx, tx, x)
}

// ReadEvaluationWithin resolves only the evaluator's current, publicly
// readable positive reaction. A cancelled or inaccessible source is nil.
func (s *Service) ReadEvaluationWithin(ctx context.Context, tx pgx.Tx, account, sourceID, kind, id string) (Object, error) {
	view, e := s.ReadEligibleWithin(ctx, tx, kind, id)
	if e != nil || view == nil {
		return nil, e
	}
	valid, e := s.currentGrowthSourceWithin(ctx, tx, account, growthRow{Kind: "evaluation", ID: sourceID, ObjectKind: kind, ObjectID: id}, view)
	if e != nil || !valid {
		return nil, e
	}
	return view, nil
}
