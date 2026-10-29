package operationsaccounts

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"strconv"
)

func sameAccountReceipt(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}

func validRestrictionAudit(audit Object, id string) (Object, bool) {
	if audit == nil || audit["account_id"] != id {
		return nil, false
	}
	name := str(audit["action"])
	if name != "restriction-set" && name != "restriction-release" {
		return nil, false
	}
	operation := str(audit["operation_id"])
	if !validID(operation) {
		return nil, false
	}
	selection := obj(audit["selection"])
	command, e := ParseRestriction(selection, name == "restriction-release")
	if e != nil || !sameAccountReceipt(selection, command) || command["operationId"] != operation {
		return nil, false
	}
	result := obj(audit["result"])
	before, after := obj(result["before"]), obj(result["restriction"])
	valid := strict(result, []string{"accountId", "before", "restriction", "operationId", "recordedAt"}, nil) && result["accountId"] == id && result["operationId"] == operation && stamp(result["recordedAt"]) != nil && validRestriction(before) && validRestriction(after) && num(before["revision"]) == num(command["expectedRevision"]) && num(after["revision"]) == num(command["expectedRevision"])+1
	if name == "restriction-set" {
		valid = valid && sameAccountReceipt(stamp(after["until"]), stamp(command["until"])) && after["reason"] == command["reason"] && after["active"] == true
	} else {
		valid = valid && after["until"] == nil && after["reason"] == nil && after["active"] == false
	}
	return command, valid
}

func (s *Service) priorDutyRestrictionWithin(ctx context.Context, tx pgx.Tx, a Actor, id string, head Object) error {
	rev := num(head["restriction_revision"])
	if rev == 0 {
		if head["restricted_until"] == nil && head["restriction_reason"] == nil {
			return nil
		}
		return fail("account_restriction_changed", 409)
	}
	metadata, e := s.domain().DutyAuthority().DutyMetadata(a)
	if e != nil {
		return e
	}
	op := obj(metadata["operation"])
	grant := str(op["grantId"])
	if grant == "" || op["grantVersion"] == nil || op["targetId"] != id {
		return fail("account_restriction_changed", 409)
	}
	var count int
	e = tx.QueryRow(ctx, `SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND account_id=$2 AND action IN ('restriction-set','restriction-release') AND result->'restriction'->>'revision'=$3`, s.Domain.Endpoint, id, strconv.FormatInt(rev, 10)).Scan(&count)
	if e != nil {
		return e
	}
	if count != 1 {
		return fail("account_restriction_changed", 409)
	}
	prior, e := one(ctx, tx, `SELECT to_jsonb(a) FROM business_admin_audit_v1 a WHERE endpoint=$1 AND account_id=$2 AND action IN ('restriction-set','restriction-release') AND result->'restriction'->>'revision'=$3`, s.Domain.Endpoint, id, strconv.FormatInt(rev, 10))
	if e != nil {
		return e
	}
	context := obj(prior["actor_context"])
	result := obj(prior["result"])
	after := obj(result["restriction"])
	_, valid := validRestrictionAudit(prior, id)
	if !valid || prior["actor_kind"] != "operations-ai-service" || prior["operator_id"] != a.ID || prior["grant_id"] != grant || !sameAccountReceipt(context["schemaVersion"], 1) || context["domain"] != metadata["domain"] || context["aiAccountId"] != metadata["aiAccountId"] || context["grantId"] != grant || !sameAccountReceipt(context["grantVersion"], op["grantVersion"]) || !validID(str(context["taskId"])) || !validID(str(context["toolCallId"])) || context["toolOperationId"] != prior["operation_id"] || num(after["revision"]) != rev || !sameAccountReceipt(stamp(after["until"]), stamp(head["restricted_until"])) || !sameAccountReceipt(after["reason"], head["restriction_reason"]) {
		return fail("account_restriction_changed", 409)
	}
	bound, e := one(ctx, tx, `SELECT jsonb_build_object('taskId',t.id,'aiAccountId',t.ai_account_id,'domain',t.domain,'planId',t.config_id,'planVersion',t.plan_version,'callId',c.call_id,'callArguments',c.arguments,'request',o.request,'proposal',o.proposal,'binding',o.binding) FROM operations_autonomy_tasks_v1 t JOIN operations_autonomy_tool_calls_v1 c ON c.endpoint=t.endpoint AND c.task_id=t.id JOIN operations_ai_duty_operations_v1 o ON o.endpoint=t.endpoint AND o.task_id=t.id AND o.operation_id=c.operation_id AND o.ai_account_id=t.ai_account_id WHERE t.endpoint=$1 AND t.id=$2 AND c.call_id=$3 AND c.operation_id=$4 AND c.tool='execute-operation' AND o.kind='account-restriction'`, s.Domain.Endpoint, context["taskId"], context["toolCallId"], prior["operation_id"])
	if e != nil {
		return e
	}
	if bound == nil {
		return fail("account_restriction_changed", 409)
	}
	request, proposal, binding := obj(bound["request"]), obj(bound["proposal"]), obj(bound["binding"])
	normalized, normalizeErr := NormalizeRestrictionRequest(obj(bound["callArguments"]))
	if normalizeErr != nil || request["targetId"] != id || !sameAccountReceipt(normalized, request) || !sameAccountReceipt(proposal["request"], request) {
		return fail("account_restriction_changed", 409)
	}
	src := businessadmin.OriginalAIReceiptSource{TaskID: str(bound["taskId"]), AIAccountID: str(bound["aiAccountId"]), Domain: str(bound["domain"]), CallID: str(bound["callId"]), OperationID: str(prior["operation_id"]), PlanID: str(bound["planId"]), PlanVersion: num(bound["planVersion"]), Request: request, Command: obj(proposal["command"]), Binding: binding, CallArguments: obj(bound["callArguments"])}
	_, state, e := s.Domain.OriginalAIRecordWithin(ctx, tx, src)
	if e != nil {
		return e
	}
	if state != "recorded" {
		return fail("account_restriction_changed", 409)
	}
	return nil
}

func (s *Service) OriginalAIReceiptWithin(ctx context.Context, tx pgx.Tx, human Actor, src businessadmin.OriginalAIReceiptSource) (Object, error) {
	return s.originalAIReceiptWithin(ctx, tx, human, src, false)
}

func (s *Service) OriginalAIReceiptQueryWithin(ctx context.Context, tx pgx.Tx, actor Actor, authority operationspermissions.Authority, src businessadmin.OriginalAIReceiptSource) (Object, error) {
	if s == nil || s.Domain == nil || !operationspermissions.OriginalAIReceiptQueryReaderMatches(authority, actor) {
		return nil, fail("business_admin_denied", 403)
	}
	fresh, e := authority.RequireWithin(ctx, tx, actor, "autonomy.read")
	if e != nil {
		return nil, e
	}
	fresh, e = authority.RequireWithin(ctx, tx, fresh, "accounts.read")
	if e != nil {
		return nil, e
	}
	clone := *s
	domain := *s.Domain
	domain.Authority, domain.Duty = authority, nil
	clone.Domain = &domain
	result, e := clone.originalAIReceiptWithin(ctx, tx, fresh, src, true)
	if e != nil {
		return nil, e
	}
	fresh, e = authority.RequireWithin(ctx, tx, fresh, "autonomy.read")
	if e != nil {
		return nil, e
	}
	if _, e = authority.RequireWithin(ctx, tx, fresh, "accounts.read"); e != nil {
		return nil, e
	}
	return result, nil
}

func (s *Service) originalAIReceiptWithin(ctx context.Context, tx pgx.Tx, actor Actor, src businessadmin.OriginalAIReceiptSource, query bool) (Object, error) {
	if s == nil || s.Domain == nil || (!query && actor.AIProof != nil) || s.Domain.IsDuty(actor) || s.Domain.IsExecution(actor) {
		return nil, fail("business_admin_denied", 403)
	}
	fresh, e := s.Domain.Fresh(ctx, tx, actor, "accounts.read")
	if e != nil {
		return nil, e
	}
	if e = s.Domain.Principal(ctx, tx, fresh); e != nil {
		return nil, e
	}
	id, action := str(src.Request["targetId"]), str(src.Request["action"])
	if src.Request["kind"] != "account-restriction" || !validID(id) || (action != "apply" && action != "release") {
		return nil, fail("not_found", 404)
	}
	if _, e = s.AccountWithin(ctx, tx, id, false); e != nil {
		return nil, e
	}
	out := Object{"state": "unknown", "operationId": src.OperationID, "metadataOnly": true}
	audit, state, e := s.Domain.OriginalAIRecordWithin(ctx, tx, src)
	if e != nil {
		return nil, e
	}
	if state == "mismatch" {
		return nil, fail("not_found", 404)
	}
	out["state"] = state
	if state == "recorded" {
		if src.Command["operationId"] != nil && src.Command["operationId"] != src.OperationID {
			return nil, fail("not_found", 404)
		}
		for _, key := range []string{"reason", "until"} {
			a, ap := src.Request[key]
			b, bp := src.Command[key]
			if ap != bp || !sameAccountReceipt(a, b) {
				return nil, fail("not_found", 404)
			}
		}
		input := Object{}
		for k, v := range src.Command {
			input[k] = v
		}
		input["operationId"] = src.OperationID
		command, err := ParseRestriction(input, action == "release")
		if err != nil {
			return nil, fail("not_found", 404)
		}
		result := obj(audit["result"])
		after := obj(result["restriction"])
		name := "restriction-set"
		if action == "release" {
			name = "restriction-release"
		}
		validated, valid := validRestrictionAudit(audit, id)
		valid = valid && audit["action"] == name && sameAccountReceipt(validated, command)
		if !valid {
			return nil, fail("not_found", 404)
		}
		out = Object{"state": "recorded", "operationId": src.OperationID, "action": "accounts.restriction." + action, "targetType": "account", "targetId": id, "version": after["revision"], "recordedAt": result["recordedAt"], "metadataOnly": true}
	}
	fresh, e = s.Domain.Fresh(ctx, tx, fresh, "accounts.read")
	if e != nil {
		return nil, e
	}
	if e = s.Domain.Principal(ctx, tx, fresh); e != nil {
		return nil, e
	}
	if _, e = s.AccountWithin(ctx, tx, id, false); e != nil {
		return nil, e
	}
	return out, nil
}
