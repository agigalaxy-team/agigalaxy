package businessadmin

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math"
)

// OriginalAIReceiptSource is constructed exclusively from the original task,
// tool call and persisted duty operation. It is never a client input or an
// execution authorization.
type OriginalAIReceiptSource struct {
	TaskID, AIAccountID, Domain, CallID, OperationID, PlanID string
	PlanVersion                                              int64
	Request, Command, Binding, CallArguments                 Object
}

func sameOriginal(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}

// OriginalAIRecordWithin validates original actor, audit coordinates and the
// frozen operation binding; no current grant or execution authority is minted.
// An absent audit row is not-recorded. Incomplete historical proof is unknown.
func (d *Domain) OriginalAIRecordWithin(ctx context.Context, tx pgx.Tx, src OriginalAIReceiptSource) (Object, string, error) {
	row, missing, e := d.OperationRecordWithin(ctx, tx, src.OperationID)
	if e != nil {
		return nil, "unknown", e
	}
	if missing {
		return nil, "unknown", nil
	}
	if row == nil {
		return nil, "not-recorded", nil
	}
	if src.Command == nil || src.Binding == nil {
		return nil, "unknown", nil
	}
	actor := obj(row, "actor_context")
	op := obj(src.Binding, "operation")
	audit := obj(src.Binding, "auditSource")
	if actor == nil || audit == nil || actor["toolCallId"] == nil || actor["toolOperationId"] == nil {
		return nil, "unknown", nil
	}
	for _, key := range []string{"grantId", "grantVersion", "strategyId", "strategyVersionId"} {
		if actor[key] == nil || op[key] == nil {
			return nil, "unknown", nil
		}
	}
	if row["grant_id"] == nil {
		return nil, "unknown", nil
	}
	for _, key := range []string{"grantId", "strategyId", "strategyVersionId"} {
		value, ok := actor[key].(string)
		if !ok {
			return nil, "mismatch", nil
		}
		if _, err := uuid.Parse(value); err != nil {
			return nil, "mismatch", nil
		}
	}
	grantVersion, ok := actor["grantVersion"].(float64)
	if !ok || grantVersion < 1 || grantVersion > 9007199254740991 || math.Trunc(grantVersion) != grantVersion {
		return nil, "mismatch", nil
	}
	permission := ""
	switch src.Request["kind"] {
	case "feedback-update":
		permission = "feedback.update"
	case "content-visibility":
		if action, ok := src.Request["action"].(string); ok && (action == "hide" || action == "restore") {
			permission = "content." + action
		}
	case "file-access":
		if action, ok := src.Request["action"].(string); ok && (action == "stop" || action == "restore") {
			permission = "files.access." + action
		}
	case "account-restriction":
		if action, ok := src.Request["action"].(string); ok && (action == "apply" || action == "release") {
			permission = "accounts.restriction." + action
		}
	case "case-resolve":
		permission = "cases.resolve"
	}
	if str(row, "actor_kind") != "operations-ai-service" || str(row, "operator_id") != "ai:"+src.AIAccountID ||
		!sameOriginal(actor["schemaVersion"], 1) || actor["taskId"] != src.TaskID || actor["aiAccountId"] != src.AIAccountID || actor["domain"] != src.Domain || actor["planId"] != src.PlanID ||
		!sameOriginal(actor["planVersion"], src.PlanVersion) || actor["toolCallId"] != src.CallID || actor["toolOperationId"] != src.OperationID || actor["judgmentKind"] != audit["kind"] || (audit["kind"] != "ai" && audit["kind"] != "code") ||
		src.Binding["taskId"] != src.TaskID || src.Binding["aiAccountId"] != src.AIAccountID || src.Binding["domain"] != src.Domain || src.Binding["planId"] != src.PlanID || !sameOriginal(src.Binding["planVersion"], src.PlanVersion) ||
		!sameOriginal(src.Binding["contextSchemaVersion"], 1) || src.Binding["accessPurpose"] != "execution" || src.Binding["endpoint"] != d.Endpoint || permission == "" || op["permission"] != permission || op["targetId"] != src.Request["targetId"] ||
		audit["callId"] != src.CallID || audit["operationId"] != src.OperationID || op["operationId"] != src.OperationID || !sameOriginal(op["request"], src.Request) || !sameOriginal(op["command"], src.Command) {
		return nil, "mismatch", nil
	}
	for _, key := range []string{"grantId", "grantVersion", "strategyId", "strategyVersionId"} {
		if !sameOriginal(actor[key], op[key]) {
			return nil, "mismatch", nil
		}
	}
	if !sameOriginal(row["grant_id"], op["grantId"]) {
		return nil, "mismatch", nil
	}
	return row, "recorded", nil
}
