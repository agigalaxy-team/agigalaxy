package filegovernance

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// CleanupCandidate reads one explicitly selected file using the exact source,
// eligibility and storage qualification used when creating a cleanup plan.
func (s *Service) CleanupCandidate(ctx context.Context, a Actor, kind, id string) (Object, error) {
	if !fileUUID.MatchString(id) {
		return nil, invalid()
	}
	if _, e := s.adapter(kind, false); e != nil {
		return nil, e
	}
	return s.run(ctx, a, "file-cleanup-read", Object{"view": "candidate", "kind": kind, "id": id}, func(tx pgx.Tx, _ Actor) (Object, error) {
		source, e := s.scopedRow(ctx, tx, kind, id, false)
		if e != nil {
			return nil, e
		}
		facts, e := s.facts(ctx, tx, kind, source, false, "")
		if e != nil {
			return nil, e
		}
		out := s.readMeta()
		out["candidate"] = s.candidate(kind, source, facts)
		return out, nil
	})
}

// OriginalCleanupCommand never executes a command. It returns only the
// original operation's owner/action/complete selection-matched receipt.
func (s *Service) OriginalCleanupCommand(ctx context.Context, a Actor, method, id string, command Object) (Object, error) {
	operation := str(command, "operationId")
	if !fileUUID.MatchString(operation) {
		return nil, invalid()
	}
	var selection Object
	action := ""
	switch method {
	case "create":
		parsed, e := ParseCleanupCreate(command)
		if e != nil {
			return nil, e
		}
		selection = Object{"operationId": operation, "command": parsed}
		action = "file-cleanup-create"
	case "cancel":
		if !fileUUID.MatchString(id) || !exact(command, "operationId", "expectedRevision") || !integer(command["expectedRevision"], 1, 9007199254740991) {
			return nil, invalid()
		}
		selection = Object{"operationId": operation, "id": id, "resourceId": id, "command": command}
		action = "file-cleanup-cancel"
	default:
		return nil, invalid()
	}
	return s.run(ctx, a, "file-cleanup-read", Object{"view": "operation", "id": operation}, func(tx pgx.Tx, current Actor) (Object, error) {
		record, e := row(ctx, tx, "SELECT to_jsonb(a) FROM business_admin_audit_v1 a WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, operation)
		if e != nil {
			return nil, e
		}
		out := s.readMeta()
		out["operationId"], out["state"] = operation, "not-recorded"
		if record == nil {
			return out, nil
		}
		equal, e := same(record["selection"], selection)
		if e != nil {
			return nil, e
		}
		if str(record, "operator_id") != current.ID || str(record, "actor_kind") != "business-operator" || str(record, "action") != action || !equal {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		result := obj(record, "result")
		planID := str(result, "planId")
		expectedState := "awaiting-approval"
		if method == "cancel" {
			expectedState = "cancelled"
		}
		if !fileUUID.MatchString(planID) || method == "cancel" && planID != id || str(result, "kind") != method || str(result, "operationId") != operation || str(result, "state") != expectedState {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		out["state"], out["kind"], out["planId"] = "recorded", method, planID
		return out, nil
	})
}
