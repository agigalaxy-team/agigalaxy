package agentos

import (
	"context"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// finishConversationRead rechecks the reader and conversation identity after a UI read.
func (s *Conversations) finishConversationRead(ctx context.Context, human operationspermissions.Actor, domain string, before CurrentConversation) (CurrentConversation, error) {
	after, err := s.readSession(ctx, human, domain)
	if err != nil {
		return after, err
	}
	oldWork, err := s.Permissions.AIWorkContext(before.Actor)
	if err != nil {
		return after, err
	}
	newWork, err := s.Permissions.AIWorkContext(after.Actor)
	if err != nil {
		return after, err
	}
	if before.Actor.ID != after.Actor.ID || permissionKey(before.Actor) != permissionKey(after.Actor) || oldWork["accountId"] != newWork["accountId"] || (before.Row == nil) != (after.Row == nil) || before.Row != nil && before.Row.ID != after.Row.ID {
		return after, fail("operations_agentos_context_changed", 409)
	}
	after.ReadExpiresAt = s.now().Unix() + 30
	return after, nil
}

func readConversationID(current CurrentConversation) any {
	if current.Row != nil {
		return current.Row.ID
	}
	return nil
}

func (s *Conversations) ReadCards(ctx context.Context, human operationspermissions.Actor, domain string) (Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	items := []Object{}
	var err error
	if s.ToolCards != nil {
		items, err = s.ToolCards(ctx, human, domain)
	} else {
		_, err = s.readSession(ctx, human, domain)
	}
	if err != nil {
		return nil, err
	}
	at := s.now().Unix()
	// Each card carries its own current source/action deadline. A short card
	// does not invalidate the list or the separate conversation history.
	return Object{"domain": domain, "items": items, "checkedAt": at}, nil
}

func (s *Conversations) ReadContext(ctx context.Context, human operationspermissions.Actor, domain string) (Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	before, err := s.readSession(ctx, human, domain)
	if err != nil {
		return nil, err
	}
	if s.Client == nil {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	status := s.Client.Status(ctx)
	latest, err := s.latestReadOperation(ctx, before)
	if err != nil {
		return nil, err
	}
	current, err := s.finishConversationRead(ctx, human, domain, before)
	if err != nil {
		return nil, err
	}
	version, _ := index(status["conversationVersion"])
	ready := (version == 1 || version == 2) && includesString(status["conversationDomains"], domain)
	configured := status["modelState"] == "configured"
	if domains, ok := status["configuredDomains"]; ok && !includesString(domains, domain) {
		configured = false
	}
	model := "not-configured"
	if configured {
		model = "configured"
	}
	if status["modelState"] == "unknown" {
		model = "unknown"
	}
	connected := status["state"] == "connected"
	var blocked any
	if !connected {
		blocked = "runtime-unavailable"
	} else if !configured {
		blocked = "model-not-configured"
	} else if !ready {
		blocked = "runtime-not-ready"
	}
	transport := object(status["conversationTransport"])
	return Object{"domain": domain, "conversationId": readConversationID(current), "contextChanged": current.ContextChanged,
		"runtimeState": status["state"], "modelState": model, "blockedReason": blocked, "latestOperation": latest,
		"capabilities": Object{"canSend": connected && configured && ready, "canStream": connected && ready && transport["events"] == true && transport["originalRunLookup"] == true, "canCancel": connected && ready && transport["cancel"] == true && transport["originalRunLookup"] == true},
		"checkedAt":    s.now().Unix(), "readExpiresAt": current.ReadExpiresAt}, nil
}

// These are original Go ledger facts, not an invented native terminal result.
// The exact operation can be read independently of history.
func (s *Conversations) latestReadOperation(ctx context.Context, current CurrentConversation) (Object, error) {
	if current.Row == nil {
		return nil, nil
	}
	var id, state string
	var run, model *string
	err := s.Pool.QueryRow(ctx, `SELECT c.id::text,c.state,COALESCE(c.native_run_id,c.result->>'runId'),r.model_state FROM operations_agentos_conversation_commands_v1 c LEFT JOIN operations_autonomy_workbench_runs_v1 r ON r.endpoint=c.endpoint AND r.turn_operation_id=c.id WHERE c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3 AND c.result->>'cancelledOperationId' IS NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 1`, s.Endpoint, current.Row.ID, current.Row.OperatorID).Scan(&id, &state, &run, &model)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var terminal any
	if model != nil {
		switch *model {
		case "completed":
			terminal = "COMPLETED"
		case "failed":
			terminal = "ERROR"
		case "cancelled":
			terminal = "CANCELLED"
		}
	}
	var runID any
	if run != nil {
		runID = *run
	}
	return Object{"operationId": id, "runId": runID, "state": state, "knownNativeStatus": terminal,
		"requiresOriginalLookup": terminal == nil && state != "not-started"}, nil
}

func (s *Conversations) ReadManagementCapabilities(ctx context.Context, human operationspermissions.Actor, domain string) (Object, error) {
	if s == nil || s.Pool == nil || s.Permissions == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	capabilities, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, err := s.Permissions.HumanAIReadWithin(ctx, tx, human, domain, "query", "workbench.read")
		if err != nil {
			return nil, err
		}
		return s.Permissions.ManagementCapabilitiesWithin(ctx, tx, actor)
	})
	if err != nil {
		return nil, err
	}
	_, err = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return s.Permissions.HumanAIWithin(ctx, tx, human, domain, "query", "workbench.read")
	})
	if err != nil {
		return nil, err
	}
	at := s.now().Unix()
	return Object{"domain": domain, "managementCapabilities": capabilities, "checkedAt": at, "readExpiresAt": at + 30}, nil
}

// Compatibility composition only. New callers use the four lanes separately.
func (s *Conversations) ReadConversation(ctx context.Context, human operationspermissions.Actor, domain string) (Object, error) {
	readers := []func(context.Context, operationspermissions.Actor, string) (Object, error){s.ReadHistory, s.ReadCards, s.ReadContext, s.ReadManagementCapabilities}
	values, failures := make([]Object, len(readers)), make([]error, len(readers))
	var group sync.WaitGroup
	for i, read := range readers {
		group.Add(1)
		go func(i int, read func(context.Context, operationspermissions.Actor, string) (Object, error)) {
			defer group.Done()
			values[i], failures[i] = read(ctx, human, domain)
		}(i, read)
	}
	group.Wait()
	for _, err := range failures {
		if err != nil {
			return nil, err
		}
	}
	if values[0]["conversationId"] != values[2]["conversationId"] {
		return nil, fail("operations_agentos_context_changed", 409)
	}
	result := copyObject(values[0])
	result["toolCards"] = values[1]["items"]
	for key, value := range values[2] {
		result[key] = value
	}
	result["managementCapabilities"] = values[3]["managementCapabilities"]
	deadline, _ := index(values[0]["readExpiresAt"])
	for _, value := range values[1:] {
		if expiry, ok := index(value["readExpiresAt"]); ok && expiry < deadline {
			deadline = expiry
		}
	}
	result["readExpiresAt"] = deadline
	return result, nil
}
