package agentos

import (
	"context"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsqueries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// A model's tool call is bound to the durable human-owned turn and its fixed AI.
// Only closed metadata enters this ledger; tool results and private prose do not.
type ConversationTools struct {
	Conversations         *Conversations
	Query                 func(context.Context, operationspermissions.Actor, string, string, Object) (Object, error)
	ReadTaskOperation     func(context.Context, operationspermissions.Actor, Conversation, Object) (Object, error)
	Summary               func(context.Context, operationspermissions.Actor, string, Object) (Object, error)
	Prepare               func(context.Context, operationspermissions.Actor, Conversation, Object, string) (Object, error)
	PrepareWithReference  func(context.Context, operationspermissions.Actor, Conversation, Object, string, Object) (Object, error)
	PrepareStored         func(context.Context, operationspermissions.Actor, Conversation, Object, string) (Object, error)
	CardReadPermission    func(string) (string, error)
	ExecutePrepared       func(context.Context, operationspermissions.Actor, Object, string, func(context.Context, pgx.Tx) (operationspermissions.Actor, error)) (Object, error)
	RecoverPrepared       func(context.Context, operationspermissions.Actor, Object, string) (Object, error)
	AuthorizedWork        func(context.Context, operationspermissions.Actor, Conversation, Object) (Object, error)
	BoundedTaskWithin     func(context.Context, pgx.Tx, Conversation, Object) error
	BoundedProposalWithin func(context.Context, pgx.Tx, Conversation, Object, Object) error
	SyncCardWithin        func(context.Context, pgx.Tx, string) error
}

type boundConversationTool struct {
	row             Conversation
	actor           operationspermissions.Actor
	callID, tool    string
	args            Object
	publicReference Object
}

var toolPairID = regexp.MustCompile(`^[\x21-\x7E]{1,200}$`)
var toolSafeError = regexp.MustCompile(`^(?:operations|business_admin|p13|search_quality|feedback|messaging|content|file|forum)_[a-z0-9_]{1,100}$`)
var toolRoute = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,79}$`)

// Only these closed tools read business state. Their call ledger and source
// descriptors are still recorded, but they cannot prepare or execute a command.
func conversationReadTool(tool string) bool {
	switch tool {
	case "plan-conversation-turn", "workbench-summary", "query-operations", "read-operation-object", "read-ai-delegation", "list-authorized-work", "read-task-operation":
		return true
	}
	return false
}

func (t *ConversationTools) bind(ctx context.Context, input Object) (boundConversationTool, error) {
	var out boundConversationTool
	_, hasReference := input["publicReference"]
	if len(input) != 7 && (!hasReference || len(input) != 8) {
		return out, fail("invalid_operations_agentos_request", 400)
	}
	for _, key := range []string{"conversationId", "sessionId", "turnId", "runId", "callId", "tool", "arguments"} {
		if _, ok := input[key]; !ok {
			return out, fail("invalid_operations_agentos_request", 400)
		}
	}
	conversationID, sessionID, turnID := text(input, "conversationId"), text(input, "sessionId"), text(input, "turnId")
	tool, runID, callID := text(input, "tool"), text(input, "runId"), text(input, "callId")
	args := object(input["arguments"])
	if !validOperationID(conversationID) || !validOperationID(sessionID) || !validOperationID(turnID) || !nativeRunID.MatchString(runID) || !toolPairID.MatchString(callID) || args == nil {
		return out, fail("invalid_operations_agentos_request", 400)
	}
	switch tool {
	case "plan-conversation-turn", "workbench-summary", "query-operations", "read-operation-object", "read-ai-delegation", "list-authorized-work", "run-authorized-work", "prepare-operation", "read-task-operation":
	default:
		return out, fail("invalid_operations_agentos_request", 400)
	}
	var reference Object
	if hasReference {
		if tool != "read-operation-object" && tool != "prepare-operation" {
			return out, fail("invalid_operations_agentos_request", 400)
		}
		var err error
		reference, err = parseConversationPublicReference(input["publicReference"])
		if err != nil {
			return out, err
		}
	}
	s := t.Conversations
	if s == nil || s.Pool == nil {
		return out, fail("operations_authorization_unavailable", 503)
	}
	currentRead, currentWithin := s.Current, s.CurrentWithin
	if conversationReadTool(tool) {
		currentRead, currentWithin = s.CurrentRead, s.CurrentReadWithin
	}
	current, err := currentRead(ctx, conversationID, nil)
	if err != nil {
		return out, err
	}
	if current.Row.SessionID != sessionID {
		return out, fail("operations_agentos_scope_denied", 403)
	}
	digest, err := conversationArgumentsDigest(args, reference)
	if err != nil {
		return out, fail("invalid_operations_agentos_request", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (boundConversationTool, error) {
		fresh, err := currentWithin(ctx, tx, conversationID, nil)
		if err != nil {
			return out, err
		}
		var storedConversation, operator, state string
		var storedRun *string
		var result Object
		err = tx.QueryRow(ctx, `SELECT conversation_id::text,operator_id,state,native_run_id,result FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE`, s.Endpoint, turnID).Scan(&storedConversation, &operator, &state, &storedRun, &result)
		if err == pgx.ErrNoRows {
			return out, fail("operations_agentos_scope_denied", 403)
		}
		if err != nil {
			return out, err
		}
		if storedConversation != conversationID || operator != fresh.Actor.ID || state == "not-started" || storedRun != nil && *storedRun != runID || result["runId"] != nil && result["runId"] != runID {
			return out, fail("operations_agentos_scope_denied", 403)
		}
		if result["taskId"] != nil {
			if t.BoundedTaskWithin == nil {
				return out, fail("operations_agentos_conversation_not_ready", 503)
			}
			if err = t.BoundedTaskWithin(ctx, tx, *fresh.Row, Object{"id": turnID, "result": result}); err != nil {
				return out, err
			}
		}
		if storedRun == nil {
			if _, err = tx.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET native_run_id=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, turnID, runID); err != nil {
				return out, err
			}
		}
		at := s.now()
		_, err = tx.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'started',$9,$9) ON CONFLICT(endpoint,conversation_id,native_run_id,call_id) DO NOTHING`, uuid.NewString(), s.Endpoint, conversationID, turnID, runID, callID, tool, digest, at)
		if err != nil {
			return out, err
		}
		var id, priorTurn, priorTool, priorDigest string
		err = tx.QueryRow(ctx, `SELECT id::text,turn_id::text,tool,arguments_digest FROM operations_agentos_conversation_tool_calls_v1 WHERE endpoint=$1 AND conversation_id=$2 AND native_run_id=$3 AND call_id=$4`, s.Endpoint, conversationID, runID, callID).Scan(&id, &priorTurn, &priorTool, &priorDigest)
		if err != nil {
			return out, err
		}
		if priorTurn != turnID || priorTool != tool || priorDigest != digest {
			return out, fail("operations_agentos_operation_conflict", 409)
		}
		return boundConversationTool{row: *fresh.Row, actor: fresh.Actor, callID: id, tool: tool, args: args, publicReference: reference}, nil
	})
}

func (t *ConversationTools) Execute(ctx context.Context, input Object) (Object, error) {
	bound, err := t.bind(ctx, input)
	if err != nil {
		return nil, err
	}
	s := t.Conversations
	var result Object
	switch bound.tool {
	case "plan-conversation-turn":
		result, err = t.planConversationTurn(ctx, bound, text(input, "turnId"))
	case "read-task-operation":
		if len(bound.args) != 2 || !validOperationID(text(bound.args, "taskId")) || !validOperationID(text(bound.args, "operationId")) {
			err = fail("invalid_operations_agentos_request", 400)
		} else if t.ReadTaskOperation == nil {
			err = fail("operations_agentos_conversation_not_ready", 503)
		} else {
			result, err = t.ReadTaskOperation(ctx, bound.actor, bound.row, bound.args)
		}
	case "read-ai-delegation":
		result, err = s.Permissions.ReadManagementTool(ctx, bound.actor, bound.row.Domain, bound.args)
	case "query-operations", "read-operation-object":
		if t.Query == nil {
			err = fail("operations_query_not_configured", 503)
		} else {
			result, err = t.Query(ctx, bound.actor, bound.row.Domain, bound.tool, bound.args)
		}
	case "workbench-summary":
		if len(bound.args) != 0 {
			err = fail("invalid_operations_agentos_request", 400)
		} else if t.Summary == nil {
			err = fail("operations_agentos_conversation_not_ready", 503)
		} else {
			result, err = t.Summary(ctx, bound.actor, bound.row.Domain, Object{"conversationId": bound.row.ID, "turnId": input["turnId"]})
		}
	case "prepare-operation":
		result, err = t.prepareCard(ctx, bound, input)
	case "list-authorized-work", "run-authorized-work":
		if bound.tool == "list-authorized-work" && len(bound.args) != 0 || bound.tool == "run-authorized-work" && (len(bound.args) != 1 || !validOperationID(text(bound.args, "executionId"))) {
			err = fail("invalid_operations_agentos_action", 400)
		} else if t.AuthorizedWork == nil {
			err = fail("operations_agentos_conversation_not_ready", 503)
		} else {
			result, err = t.AuthorizedWork(ctx, bound.actor, bound.row, Object{"tool": bound.tool, "arguments": bound.args})
		}
	default:
		err = fail("operations_agentos_conversation_not_ready", 503)
	}
	if err == nil && bound.publicReference != nil && bound.tool == "read-operation-object" {
		err = checkConversationPublicReference(bound.publicReference, bound.args, object(result["data"]))
	}
	if err == nil && (bound.tool == "query-operations" || bound.tool == "read-operation-object" || bound.tool == "read-ai-delegation" || bound.tool == "read-task-operation") {
		err = t.rememberSources(ctx, bound.row, result["evidenceRefs"])
	}
	if err == nil {
		currentRead := s.Current
		if conversationReadTool(bound.tool) {
			currentRead = s.CurrentRead
		}
		_, err = currentRead(ctx, bound.row.ID, nil)
	}
	metadata := Object{"tool": bound.tool}
	metadata["module"], metadata["view"] = nil, nil
	if bound.tool == "read-task-operation" {
		metadata["module"], metadata["view"] = "autonomy", "original-operation"
		if len(bound.args) == 2 && validOperationID(text(bound.args, "taskId")) && validOperationID(text(bound.args, "operationId")) {
			metadata["taskId"], metadata["operationId"] = bound.args["taskId"], bound.args["operationId"]
		}
	}
	if err == nil && (bound.tool == "query-operations" || bound.tool == "read-operation-object") && result["tool"] == bound.tool {
		if module, _ := result["module"].(string); toolRoute.MatchString(module) {
			metadata["module"] = module
		}
		if view, _ := result["view"].(string); toolRoute.MatchString(view) {
			metadata["view"] = view
		}
	}
	if err != nil && (bound.tool == "query-operations" || bound.tool == "read-operation-object") {
		metadata["module"], metadata["view"] = operationsqueries.ReceiptRoute(bound.tool, bound.args)
	}
	if bound.tool == "read-ai-delegation" && (len(bound.args) == 0 || len(bound.args) == 1 && validOperationID(text(bound.args, "aiAccountId"))) {
		metadata["module"], metadata["view"] = "permissions", "ai-delegation"
		if bound.args["aiAccountId"] != nil {
			metadata["view"] = "ai-work-prompt"
		}
	}
	state := "completed"
	if err != nil {
		state = "unavailable"
		for key, value := range conversationToolFailure(err) {
			metadata[key] = value
		}
	} else {
		metadata["cardId"] = nil
		if bound.tool == "read-task-operation" {
			metadata["taskId"], metadata["operationId"] = bound.args["taskId"], bound.args["operationId"]
			metadata["receiptState"] = object(result["receipt"])["state"]
		}
		if card := object(result["card"]); card != nil {
			metadata["cardId"] = card["cardId"]
		}
		metadata["state"] = "read"
		if result["state"] != nil {
			metadata["state"] = result["state"]
		} else if result["availability"] != nil {
			metadata["state"] = result["availability"]
		}
	}
	// Cancellation ends the actual read immediately. Only its already observed,
	// closed outcome is persisted independently, so a timed-out client cannot
	// leave the durable call permanently started. A late failed retry cannot
	// replace an earlier successful observation of this same exact call.
	settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	_, saveErr := s.Pool.Exec(settle, `UPDATE operations_agentos_conversation_tool_calls_v1 SET state=$3,metadata=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2 AND (state='started' OR state='unavailable' AND $3='completed')`, s.Endpoint, bound.callID, state, metadata, s.now())
	if saveErr != nil {
		return nil, saveErr
	}
	return result, err
}
