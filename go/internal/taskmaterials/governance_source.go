package taskmaterials

import (
	"context"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// GovernanceSourceWithin is the original target-governance source projection.
// The caller owns the moderation transaction; this grants no Task content read.
func (s *Service) GovernanceSourceWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, authorize, lock bool) (Object, error) {
	var current Object
	var e error
	if authorize {
		access, err := s.RequireTaskWithin(ctx, tx, a, id, lock)
		if err != nil {
			return nil, err
		}
		current = obj(access, "row")
	} else {
		sql := "SELECT to_jsonb(t) FROM task_requests t WHERE id=$1"
		if lock {
			sql += " FOR UPDATE"
		}
		current, e = row(ctx, tx, sql, id)
		if e != nil {
			return nil, e
		}
	}
	if current == nil {
		return nil, fail("target_unavailable", 404)
	}
	partyRows, e := rows(ctx, tx, "SELECT jsonb_build_object('subject_id',subject_id) FROM task_participations WHERE task_id=$1 AND snapshot->>'confirmedAt' IS NOT NULL UNION SELECT jsonb_build_object('subject_id',subject_id) FROM task_events WHERE task_id=$1", id)
	if e != nil {
		return nil, e
	}
	parties := []string{str(current, "requester_id")}
	for _, p := range partyRows {
		if !contains(parties, str(p, "subject_id")) {
			parties = append(parties, str(p, "subject_id"))
		}
	}
	root, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", current["root_event_id"])
	if e != nil {
		return nil, e
	}
	available := !truth(obj(current, "snapshot")["contentDeleted"])
	if available {
		if _, e = s.grant(ctx, tx, root); e != nil {
			var f *fault.Error
			if !errors.As(e, &f) || (f.Status != 403 && f.Status != 404 && f.Status != 410) {
				return nil, e
			}
			available = false
		}
	}
	if current["case_id"] != nil {
		parent, e := row(ctx, tx, "SELECT jsonb_build_object('state',state) FROM cases WHERE id=$1 AND subject_id=$2", current["case_id"], current["requester_id"])
		if e != nil {
			return nil, e
		}
		if parent == nil || parent["state"] == "withdrawn" {
			available = false
		}
	}
	return Object{"target": Object{"type": "task", "id": current["id"], "version": current["version"], "rootEventId": current["root_event_id"]}, "parties": parties, "sourceAvailable": available, "state": obj(current, "snapshot")["state"], "contentAccess": "requires-separate-current-task-permission"}, nil
}
