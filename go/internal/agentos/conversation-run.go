package agentos

import (
	"context"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

type AuthorizeConversation func(context.Context) (operationspermissions.Actor, error)
type conversationTurn struct{ ID, Message, TaskID, RetryID string }

func parseConversationTurn(input Object) (conversationTurn, error) {
	var turn conversationTurn
	for key, value := range input {
		text, ok := value.(string)
		if !ok {
			return turn, fail("invalid_operations_agentos_request", 400)
		}
		switch key {
		case "operationId":
			turn.ID = text
		case "message":
			turn.Message = text
		case "taskId":
			turn.TaskID = text
		case "retryOfOperationId":
			turn.RetryID = text
		default:
			return turn, fail("invalid_operations_agentos_request", 400)
		}
		if key != "message" && !validOperationID(text) {
			return turn, fail("invalid_operations_agentos_request", 400)
		}
	}
	turn.Message = strings.TrimFunc(turn.Message, func(r rune) bool { return r == '\ufeff' || unicode.IsSpace(r) && r != 0x85 })
	if !validOperationID(turn.ID) || utf8.RuneCountInString(turn.Message) < 1 || utf8.RuneCountInString(turn.Message) > 12000 {
		return turn, fail("invalid_operations_agentos_request", 400)
	}
	return turn, nil
}

func (s *Conversations) fresh(ctx context.Context, operator operationspermissions.Actor, authorize AuthorizeConversation) (operationspermissions.Actor, error) {
	if authorize == nil {
		return operationspermissions.Actor{}, fail("operations_authorization_unavailable", 503)
	}
	actor, err := authorize(ctx)
	if err != nil {
		return actor, err
	}
	if actor.ID != operator.ID || actor.Endpoint != s.Endpoint {
		return actor, fail("business_admin_denied", 403)
	}
	return actor, nil
}

func includesString(value any, wanted string) bool {
	items, ok := value.([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		if item == wanted {
			return true
		}
	}
	return false
}

// A retry is a new explicitly requested turn. It is only eligible when the
// original failure and the same-owner business ledger establish no effect.
func retryableOriginalConversationRun(run Object, message string) bool {
	activity := object(run["businessActivity"])
	if run["status"] != "ERROR" || !nativeRunID.MatchString(text(run, "runId")) || run["userInput"] != message || activity["state"] != "not-started" || activity["basis"] != "same-owner-turn-tool-and-card-ledger" {
		return false
	}
	switch run["errorCode"] {
	case "operations_authorization_unavailable":
		return run["failure"] == nil
	case "operations_agentos_model_request_failed":
		category := text(object(run["failure"]), "category")
		return category == "" || category == "rate-limit" || category == "timeout" || category == "connection" || category == "service-unavailable" || category == "unknown"
	default:
		return false
	}
}

func (s *Conversations) Run(ctx context.Context, operator operationspermissions.Actor, domain string, input Object, authorize AuthorizeConversation) (Object, error) {
	return s.runWithContext(ctx, operator, domain, input, authorize, nil)
}

func (s *Conversations) runWithContext(ctx context.Context, operator operationspermissions.Actor, domain string, input Object, authorize AuthorizeConversation, continuation Object) (Object, error) {
	turn, err := parseConversationTurn(input)
	if err != nil || !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	fresh, err := s.fresh(ctx, operator, authorize)
	if err != nil {
		return nil, err
	}
	if _, err = s.Session(ctx, fresh, domain, false); err != nil {
		return nil, err
	}
	old, err := s.command(ctx, turn.ID)
	if err != nil {
		return nil, err
	}
	if old != nil {
		if old.OperatorID != operator.ID || old.Domain != domain || old.Digest != turnDigest(turn.Message, turn.TaskID, turn.RetryID) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return s.Operation(ctx, fresh, domain, turn.ID)
	}
	if s.Client == nil {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	status := s.Client.Status(ctx)
	if status["state"] != "connected" {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	if status["modelState"] != "configured" {
		return nil, fail("operations_agentos_model_not_configured", 503)
	}
	if configured, present := status["configuredDomains"]; present && !includesString(configured, domain) {
		return nil, fail("operations_agentos_model_not_configured", 503)
	}
	version, _ := index(status["conversationVersion"])
	if version != 1 && version != 2 || !includesString(status["conversationDomains"], domain) {
		return nil, fail("operations_agentos_conversation_not_ready", 503)
	}
	current, err := s.Session(ctx, fresh, domain, true)
	if err != nil {
		return nil, err
	}
	row := *current.Row
	receipt := Object{"operationId": turn.ID, "runId": nil, "state": "dispatching", "native": nil, "replayed": false}
	for key, value := range continuation {
		receipt[key] = value
	}
	if turn.TaskID != "" {
		receipt["taskId"] = turn.TaskID
	}
	var retryRun string
	if turn.RetryID != "" {
		parent, err := s.command(ctx, turn.RetryID)
		if err != nil {
			return nil, err
		}
		if parent == nil || parent.ConversationID != row.ID || parent.OperatorID != fresh.ID || parent.Result["cancelledOperationId"] != nil || parent.Digest != turnDigest(turn.Message, turn.TaskID, text(parent.Result, "retryOfOperationId")) {
			return nil, fail("operations_agentos_retry_unavailable", 409)
		}
		original, err := s.nativeOperation(ctx, row, parent)
		if err != nil {
			return nil, err
		}
		if original == nil {
			return nil, fail("operations_agentos_retry_unavailable", 409)
		}
		original = copyObject(original)
		original["operationId"] = parent.ID
		runs, err := s.decorateRuns(ctx, row, []Object{original})
		if err != nil {
			return nil, err
		}
		checked := runs[0]
		if !retryableOriginalConversationRun(checked, turn.Message) {
			return nil, fail("operations_agentos_retry_unavailable", 409)
		}
		retryRun = text(checked, "runId")
		receipt["retryOfOperationId"], receipt["retryOfRunId"], receipt["priorFailure"] = parent.ID, retryRun, Object{"status": "ERROR", "errorCode": checked["errorCode"], "failure": checked["failure"]}
	}
	inserted, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		if _, err := s.Permissions.HumanAIWithin(ctx, tx, fresh, domain, "conversation", "workbench.read"); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", s.Endpoint+":conversation:"+turn.ID); err != nil {
			return false, err
		}
		// Serialize admission across different operations in the same conversation.
		// The lock is held only for local ledger work, never for a native request.
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", s.Endpoint+":conversation-admission:"+row.ID); err != nil {
			return false, err
		}
		if turn.RetryID != "" {
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", s.Endpoint+":conversation-retry:"+turn.RetryID); err != nil {
				return false, err
			}
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND result->>'retryOfOperationId'=$4 AND state<>'not-started' AND id<>$5)`, s.Endpoint, row.ID, fresh.ID, turn.RetryID, turn.ID).Scan(&exists); err != nil {
				return false, err
			}
			if exists {
				return false, fail("operations_agentos_retry_already_requested", 409)
			}
		}
		var priorOwner, priorConversation, digest string
		err := tx.QueryRow(ctx, "SELECT operator_id,conversation_id::text,message_digest FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2", s.Endpoint, turn.ID).Scan(&priorOwner, &priorConversation, &digest)
		if err == nil {
			if priorOwner != fresh.ID || priorConversation != row.ID || digest != turnDigest(turn.Message, turn.TaskID, turn.RetryID) {
				return false, fail("operations_agentos_operation_conflict", 409)
			}
			return false, nil
		}
		if err != pgx.ErrNoRows {
			return false, err
		}
		if err := s.requireConversationAvailableWithin(ctx, tx, row, turn.ID); err != nil {
			return false, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,$5,'dispatching',$6,$7)`, turn.ID, s.Endpoint, row.ID, fresh.ID, turnDigest(turn.Message, turn.TaskID, turn.RetryID), receipt, s.now()); err != nil {
			return false, err
		}
		if s.LinkWorkbenchWithin != nil {
			return true, s.LinkWorkbenchWithin(ctx, tx, row, turn.ID, turn.TaskID)
		}
		if turn.TaskID != "" {
			return false, fail("operations_autonomy_workbench_not_ready", 503)
		}
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	if !inserted {
		return s.Operation(ctx, fresh, domain, turn.ID)
	}
	result := copyObject(receipt)
	again, dispatchErr := s.fresh(ctx, fresh, authorize)
	if dispatchErr == nil {
		_, dispatchErr = s.Current(ctx, row.ID, &again)
	}
	if dispatchErr == nil {
		transport := object(status["conversationTransport"])
		var native any
		native, dispatchErr = s.Client.RunConversation(ctx, row.Execution(), ConversationRun{RunID: turn.ID, Message: turn.Message, Stream: transport["events"] == true && transport["originalRunLookup"] == true, RetryOfRunID: retryRun, RetryOfOperationID: turn.RetryID})
		if dispatchErr == nil {
			ack := object(native)
			result["runId"] = ack["run_id"]
			if result["runId"] == nil {
				result["runId"] = ack["runId"]
			}
			result["state"] = "accepted"
		}
	}
	if dispatchErr != nil {
		result["state"] = "unknown"
		if forbidden(dispatchErr) || fault.Code(dispatchErr) == "operations_agentos_model_not_configured" {
			result["state"] = "not-started"
		}
	}
	_, err = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		if _, err := tx.Exec(ctx, "UPDATE operations_agentos_conversation_commands_v1 SET state=$3,result=result || $4::jsonb,native_run_id=COALESCE(native_run_id,$5) WHERE endpoint=$1 AND id=$2", s.Endpoint, turn.ID, result["state"], result, result["runId"]); err != nil {
			return false, err
		}
		if s.UpdateWorkbenchWithin != nil {
			fact := Object{"modelState": "unknown", "status": "unknown"}
			if result["state"] == "accepted" {
				fact["modelState"], fact["status"] = "accepted", "running"
			} else if result["state"] == "not-started" {
				fact["modelState"], fact["status"] = "not-started", "failed"
			}
			if result["runId"] != nil {
				fact["nativeRunId"] = result["runId"]
			}
			if err := s.updateWorkbench(ctx, tx, turn.ID, fact); err != nil {
				return false, err
			}
		}
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	final, err := s.fresh(ctx, fresh, authorize)
	if err != nil {
		return nil, err
	}
	if _, err = s.Current(ctx, row.ID, &final); err != nil {
		return nil, err
	}
	if runID := text(result, "runId"); runID != "" {
		projected, e := s.decorateRuns(ctx, row, []Object{{"operationId": turn.ID, "runId": runID, "status": "RUNNING"}})
		if e == nil {
			result["sentAt"] = projected[0]["sentAt"]
		}
	}
	return result, nil
}
