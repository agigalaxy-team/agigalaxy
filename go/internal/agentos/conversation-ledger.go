package agentos

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type conversationCommand struct {
	ID, ConversationID, OperatorID, Domain, Digest, State string
	NativeRunID                                           *string
	Result                                                Object
	CreatedAt                                             time.Time
}

func (s *Conversations) command(ctx context.Context, id string) (*conversationCommand, error) {
	var row conversationCommand
	err := s.Pool.QueryRow(ctx, `SELECT c.id::text,c.conversation_id::text,c.operator_id,s.domain,c.message_digest,c.state,c.native_run_id,c.result,c.created_at FROM operations_agentos_conversation_commands_v1 c JOIN operations_agentos_conversations_v1 s ON s.id=c.conversation_id WHERE c.endpoint=$1 AND c.id=$2`, s.Endpoint, id).Scan(&row.ID, &row.ConversationID, &row.OperatorID, &row.Domain, &row.Digest, &row.State, &row.NativeRunID, &row.Result, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &row, err
}

func (s *Conversations) nativeOperation(ctx context.Context, row Conversation, command *conversationCommand) (Object, error) {
	known := text(command.Result, "runId")
	if command.NativeRunID != nil {
		known = *command.NativeRunID
	}
	// Current transports resolve one original durable operation directly. An
	// uncertain/missing exact lookup is not permission to scan another history
	// or issue the operation again. Legacy transports retain their history read.
	status := s.Client.Status(ctx)
	if object(status["conversationTransport"])["originalRunLookup"] != true {
		value, err := s.Client.ReadConversation(ctx, row.Execution())
		if err != nil {
			if forbidden(err) {
				return nil, err
			}
			return nil, nil
		}
		runs, _ := object(value)["runs"].([]any)
		for _, entry := range runs {
			run := object(entry)
			if run["operationId"] == command.ID || known != "" && run["runId"] == known {
				if operation := run["operationId"]; operation != nil && operation != command.ID {
					return nil, streamInvalid()
				}
				return run, nil
			}
		}
		return nil, nil
	}
	value, err := s.Client.ReadConversationOperation(ctx, row.Execution(), command.ID)
	if err != nil {
		if forbidden(err) {
			return nil, err
		}
		return nil, nil
	}
	original := object(value)
	runID := text(original, "runId")
	if original["operationId"] != command.ID || original["runId"] != nil && (!nativeRunID.MatchString(runID) || known != "" && known != runID) {
		return nil, streamInvalid()
	}
	// New responses state the exact context as well. Older v2 responses were
	// already bound by their private conversation JWT and native session check.
	if id, present := original["conversationId"]; present && id != row.ID {
		return nil, streamInvalid()
	}
	if session, present := original["sessionId"]; present && session != row.SessionID {
		return nil, streamInvalid()
	}
	if runID == "" || original["state"] == "not-recorded" {
		return nil, nil
	}
	if native := object(original["native"]); native != nil {
		if native["runId"] != runID || native["operationId"] != command.ID {
			return nil, streamInvalid()
		}
		return native, nil
	}
	state := text(original, "state")
	if state != "PENDING" && state != "RUNNING" && state != "CANCELLED" && state != "ERROR" {
		state = "unknown"
	}
	return Object{"runId": runID, "operationId": command.ID, "status": state, "content": nil, "userInput": nil, "createdAt": nil, "events": []any{}, "awaitingHuman": false}, nil
}

func text(value Object, key string) string { result, _ := value[key].(string); return result }
func validOperationID(value string) bool   { return len(value) == 36 && uuid.Validate(value) == nil }
func validConversationDomain(value string) bool {
	switch value {
	case "overview", "governance", "messaging", "discovery", "maintenance":
		return true
	}
	return false
}
func forbidden(err error) bool { return fault.Status(err) == 403 }
func copyObject(source Object) Object {
	out := Object{}
	for key, value := range source {
		out[key] = value
	}
	return out
}

func (s *Conversations) Operation(ctx context.Context, actor operationspermissions.Actor, domain, id string) (Object, error) {
	if !validConversationDomain(domain) || !validOperationID(id) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	if _, err := s.Session(ctx, actor, domain, false); err != nil {
		return nil, err
	}
	saved, err := s.command(ctx, id)
	if err != nil {
		return nil, err
	}
	if saved == nil || saved.OperatorID != actor.ID || saved.Domain != domain {
		return nil, fail("operations_agentos_operation_not_found", 404)
	}
	current, err := s.Current(ctx, saved.ConversationID, &actor)
	if err != nil {
		if fault.Code(err) != "operations_agentos_source_changed" {
			return nil, err
		}
		result := copyObject(saved.Result)
		result["state"], result["native"], result["contextChanged"], result["replayed"] = "context-changed", nil, true, true
		return result, nil
	}
	target := saved
	if parent := text(saved.Result, "cancelledOperationId"); parent != "" {
		target, err = s.command(ctx, parent)
		if err != nil {
			return nil, err
		}
		if target == nil || target.ConversationID != current.Row.ID || target.OperatorID != actor.ID || target.Result["cancelledOperationId"] != nil {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
	}
	native, err := s.nativeOperation(ctx, *current.Row, target)
	if err != nil {
		return nil, err
	}
	if native != nil {
		runs, err := s.decorateRuns(ctx, *current.Row, []Object{native})
		if err != nil {
			return nil, err
		}
		native = runs[0]
	}
	if _, err = s.Current(ctx, current.Row.ID, &actor); err != nil {
		return nil, err
	}
	if native != nil && s.SyncWorkbenchRuns != nil {
		if err = s.SyncWorkbenchRuns(ctx, *current.Row, []Object{native}); err != nil {
			return nil, err
		}
	}
	result := copyObject(saved.Result)
	state := saved.State
	if native != nil && native["status"] != nil {
		state = text(native, "status")
	} else if state == "dispatching" {
		state = "unknown"
	}
	result["state"], result["native"], result["replayed"] = state, native, true
	return result, nil
}

// Wire equality helper is deliberately local: signed business bytes continue
// to use their domain's original ordered serializers.
func turnDigest(message string, taskID, retryID string) string {
	if retryID != "" {
		var task any
		if taskID != "" {
			task = taskID
		}
		raw, _ := protocol.EncodeJS([]any{message, task, retryID})
		return identity.Digest(raw)
	}
	if taskID != "" {
		raw, _ := protocol.EncodeJS([]any{message, taskID})
		return identity.Digest(raw)
	}
	return identity.Digest([]byte(message))
}
