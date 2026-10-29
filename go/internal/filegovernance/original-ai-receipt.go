package filegovernance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

func (s *Service) OriginalAIReceiptWithin(ctx context.Context, tx pgx.Tx, human Actor, src businessadmin.OriginalAIReceiptSource) (Object, error) {
	return s.originalAIReceiptWithin(ctx, tx, human, src, false)
}

func (s *Service) OriginalAIReceiptQueryWithin(ctx context.Context, tx pgx.Tx, actor Actor, authority operationspermissions.Authority, src businessadmin.OriginalAIReceiptSource) (Object, error) {
	if s == nil || !operationspermissions.OriginalAIReceiptQueryReaderMatches(authority, actor) {
		return nil, fail("business_admin_denied", 403)
	}
	fresh, e := authority.RequireWithin(ctx, tx, actor, "autonomy.read")
	if e != nil {
		return nil, e
	}
	fresh, e = authority.RequireWithin(ctx, tx, fresh, "files.read")
	if e != nil {
		return nil, e
	}
	clone := *s
	clone.Authority, clone.Duty = authority, nil
	result, e := clone.originalAIReceiptWithin(ctx, tx, fresh, src, true)
	if e != nil {
		return nil, e
	}
	fresh, e = authority.RequireWithin(ctx, tx, fresh, "autonomy.read")
	if e != nil {
		return nil, e
	}
	if _, e = authority.RequireWithin(ctx, tx, fresh, "files.read"); e != nil {
		return nil, e
	}
	return result, nil
}

func sameFileReceipt(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}

func (s *Service) originalAIReceiptWithin(ctx context.Context, tx pgx.Tx, actor Actor, src businessadmin.OriginalAIReceiptSource, query bool) (Object, error) {
	if s == nil || (!query && actor.AIProof != nil) || s.domain().IsDuty(actor) || s.domain().IsExecution(actor) {
		return nil, fail("business_admin_denied", 403)
	}
	current, e := s.fresh(ctx, tx, actor, "files.read")
	if e != nil {
		return nil, e
	}
	if e = s.principal(ctx, tx, current); e != nil {
		return nil, e
	}
	id, kind, action := str(src.Request, "targetId"), str(src.Request, "targetKind"), str(src.Request, "action")
	if src.Request["kind"] != "file-access" || !fileUUID.MatchString(id) || (kind != "chat" && kind != "forum") || (action != "stop" && action != "restore") {
		return nil, fail("not_found", 404)
	}
	if _, e = s.ScopeFileAccessWithin(ctx, tx, kind, id, false); e != nil {
		return nil, e
	}
	out := Object{"state": "unknown", "operationId": src.OperationID, "metadataOnly": true}
	audit, state, e := s.domain().OriginalAIRecordWithin(ctx, tx, src)
	if e != nil {
		return nil, e
	}
	if state == "mismatch" {
		return nil, fail("not_found", 404)
	}
	event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM operations_file_access_events_v1 e WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, src.OperationID)
	if e != nil {
		return nil, e
	}
	if state == "not-recorded" && event == nil {
		out["state"] = "not-recorded"
	}
	if state == "recorded" && event != nil {
		if src.Command["operationId"] != nil && src.Command["operationId"] != src.OperationID {
			return nil, fail("not_found", 404)
		}
		for _, key := range []string{"action", "reason", "until"} {
			a, ap := src.Request[key]
			b, bp := src.Command[key]
			if ap != bp || !sameFileReceipt(a, b) {
				return nil, fail("not_found", 404)
			}
		}
		input := Object{}
		for k, v := range src.Command {
			input[k] = v
		}
		input["operationId"] = src.OperationID
		command, err := ParseAccessChange(input)
		if err != nil {
			return nil, fail("not_found", 404)
		}
		var until any
		if event["stopped_until"] != nil {
			until = timestamp(event["stopped_until"]).Unix()
		}
		revision := num(event, "revision")
		if str(event, "kind") != kind || str(event, "file_id") != id || str(event, "operator_id") != "ai:"+src.AIAccountID || str(event, "action") != action || str(event, "expected_version") != str(command, "expectedVersion") || num(event, "expected_revision") != num(command, "expectedRevision") || revision != num(command, "expectedRevision")+1 || event["reason"] != command["reason"] || !sameFileReceipt(until, command["until"]) || iso(event["created_at"]) == nil {
			return nil, fail("not_found", 404)
		}
		selection := Object{"kind": kind, "id": id, "resourceId": id, "action": action, "revision": revision, "until": command["until"]}
		result := Object{"kind": kind, "id": id, "action": action, "revision": revision, "stopped": action == "stop", "until": iso(event["stopped_until"]), "operationId": src.OperationID, "recordedAt": iso(event["created_at"])}
		if audit["action"] != "file-access-"+action || !sameFileReceipt(audit["selection"], selection) || !sameFileReceipt(audit["result"], result) {
			return nil, fail("not_found", 404)
		}
		out = Object{"state": "recorded", "operationId": src.OperationID, "action": "files.access." + action, "targetType": "file-" + kind, "targetId": id, "version": revision, "recordedAt": iso(event["created_at"]), "metadataOnly": true}
	}
	current, e = s.fresh(ctx, tx, current, "files.read")
	if e != nil {
		return nil, e
	}
	if e = s.principal(ctx, tx, current); e != nil {
		return nil, e
	}
	if _, e = s.ScopeFileAccessWithin(ctx, tx, kind, id, false); e != nil {
		return nil, e
	}
	return out, nil
}
