package operationscommunity

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

func (s *Service) CaseOriginalAIReceiptWithin(ctx context.Context, tx pgx.Tx, actor Actor, src businessadmin.OriginalAIReceiptSource) (Object, error) {
	return s.caseOriginalAIReceiptWithin(ctx, tx, actor, src, false)
}

func (s *Service) CaseOriginalAIReceiptQueryWithin(ctx context.Context, tx pgx.Tx, actor Actor, authority operationspermissions.Authority, src businessadmin.OriginalAIReceiptSource) (Object, error) {
	if s == nil || !operationspermissions.OriginalAIReceiptQueryReaderMatches(authority, actor) {
		return nil, fail("business_admin_denied", 403)
	}
	fresh, e := authority.RequireWithin(ctx, tx, actor, "autonomy.read")
	if e != nil {
		return nil, e
	}
	fresh, e = authority.RequireWithin(ctx, tx, fresh, "cases.read")
	if e != nil {
		return nil, e
	}
	clone := *s
	clone.Authority, clone.Duty = authority, nil
	out, e := clone.caseOriginalAIReceiptWithin(ctx, tx, fresh, src, true)
	if e != nil {
		return nil, e
	}
	fresh, e = authority.RequireWithin(ctx, tx, fresh, "autonomy.read")
	if e != nil {
		return nil, e
	}
	if _, e = authority.RequireWithin(ctx, tx, fresh, "cases.read"); e != nil {
		return nil, e
	}
	return out, nil
}

func sameCaseValue(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}

func (s *Service) caseOriginalAIReceiptWithin(ctx context.Context, tx pgx.Tx, actor Actor, src businessadmin.OriginalAIReceiptSource, query bool) (Object, error) {
	d := s.domain()
	if (!query && actor.AIProof != nil) || d.IsDuty(actor) || d.IsExecution(actor) {
		return nil, fail("business_admin_denied", 403)
	}
	current, e := d.Fresh(ctx, tx, actor, "autonomy.read")
	if e != nil {
		return nil, e
	}
	id := str(src.Request, "targetId")
	if src.Request["kind"] != "case-resolve" || !validID(id) || !validID(src.OperationID) {
		return nil, fail("not_found", 404)
	}
	if _, e = s.CaseReadSourceWithin(ctx, tx, current, id); e != nil {
		return nil, e
	}
	row, state, e := d.OriginalAIRecordWithin(ctx, tx, src)
	if e != nil {
		return nil, e
	}
	if state == "mismatch" {
		return nil, fail("not_found", 404)
	}
	event, e := one(ctx, tx, `SELECT to_jsonb(e) FROM forum_operations_events_v1 e WHERE id=$1`, src.OperationID)
	if e != nil {
		return nil, e
	}
	if state == "not-recorded" && event != nil || state == "recorded" && event == nil {
		state = "unknown"
	}
	// Retained event material must not be consumed after its original deadline.
	if state == "recorded" && (iso(event["retained_until"]) == nil || seconds(event["retained_until"]) <= s.now()) {
		state = "unknown"
	}
	out := Object{"state": state, "operationId": src.OperationID, "metadataOnly": true}
	if state == "recorded" {
		input := copyObject(src.Command)
		if input["operationId"] != nil && input["operationId"] != src.OperationID {
			return nil, fail("not_found", 404)
		}
		input["operationId"] = src.OperationID
		command, err := parseWrite(input, "resolve")
		if err != nil {
			return nil, fail("not_found", 404)
		}
		for _, key := range []string{"resolution", "summary", "restrictionAction", "hideUntil"} {
			want, present := src.Request[key]
			got, exists := command[key]
			if present != exists || !sameCaseValue(want, got) {
				return nil, fail("not_found", 404)
			}
		}
		expected := copyObject(command)
		delete(expected, "summary")
		expected["id"], expected["resourceId"], expected["summaryDigest"] = id, id, digest(str(command, "summary"))
		selection, result := obj(row, "selection"), obj(row, "result")
		action := str(command, "restrictionAction")
		if action == "" {
			action = "keep"
			if command["hideUntil"] != nil {
				action = "hide"
			}
		}
		version := num(command, "expectedVersion") + 1
		if !sameCaseValue(expected, selection) || row["action"] != "community-report-resolve" || result["operationId"] != src.OperationID || result["reportId"] != id || num(result, "version") != version || result["state"] != "resolved" || result["resolution"] != command["resolution"] || result["restrictionAction"] != action || iso(result["recordedAt"]) == nil || event["report_id"] != id || event["operator_id"] != "ai:"+src.AIAccountID || event["actor_kind"] != "operations-ai-service" || num(event, "version") != version || event["resolution"] != command["resolution"] || event["summary"] != command["summary"] || event["restriction_action"] != action || iso(event["created_at"]) == nil || !sameCaseValue(iso(event["effect_until"]), iso(result["effectUntil"])) {
			return nil, fail("not_found", 404)
		}
		if action == "hide" && (!sameCaseValue(iso(event["effect_until"]), iso(stamp(num(command, "hideUntil")))) || result["restrictionEventId"] != src.OperationID) {
			return nil, fail("not_found", 404)
		}
		if result["effectUntil"] != nil && iso(result["effectUntil"]) == nil {
			return nil, fail("not_found", 404)
		}
		if action == "release" && (event["effect_until"] != nil || result["effectUntil"] != nil || result["restrictionEventId"] != nil) {
			return nil, fail("not_found", 404)
		}
		out = Object{"state": "recorded", "operationId": src.OperationID, "action": "cases.resolve", "targetType": "community-report", "targetId": id, "version": result["version"], "recordedAt": result["recordedAt"], "metadataOnly": true}
	}
	current, e = d.Fresh(ctx, tx, current, "autonomy.read")
	if e != nil {
		return nil, e
	}
	if _, e = s.CaseReadSourceWithin(ctx, tx, current, id); e != nil {
		return nil, e
	}
	return out, nil
}
