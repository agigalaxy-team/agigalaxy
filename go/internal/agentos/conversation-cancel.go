package agentos

import (
	"context"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func terminalConversation(state any) bool {
	switch state {
	case "COMPLETED", "CANCELLED", "ERROR", "PAUSED":
		return true
	}
	return false
}

func (s *Conversations) Cancel(ctx context.Context, operator operationspermissions.Actor, domain, parentID string, input Object, authorize AuthorizeConversation) (Object, error) {
	operationID, ok := input["operationId"].(string)
	if !ok || len(input) != 1 || !validOperationID(operationID) || !validOperationID(parentID) || operationID == parentID || !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	fresh, err := s.fresh(ctx, operator, authorize)
	if err != nil {
		return nil, err
	}
	if _, err = s.Session(ctx, fresh, domain, false); err != nil {
		return nil, err
	}
	parent, err := s.command(ctx, parentID)
	if err != nil {
		return nil, err
	}
	if parent == nil || parent.OperatorID != operator.ID || parent.Domain != domain || parent.Result["cancelledOperationId"] != nil {
		return nil, fail("operations_agentos_operation_not_found", 404)
	}
	current, err := s.Current(ctx, parent.ConversationID, &fresh)
	if err != nil {
		return nil, err
	}
	row := *current.Row
	digest := identity.Digest([]byte("cancel:" + parentID))
	old, err := s.command(ctx, operationID)
	if err != nil {
		return nil, err
	}
	if old != nil {
		if old.OperatorID != operator.ID || old.ConversationID != row.ID || old.Digest != digest {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return s.Operation(ctx, fresh, domain, operationID)
	}
	status := s.Client.Status(ctx)
	transport := object(status["conversationTransport"])
	if status["state"] != "connected" || transport["cancel"] != true || transport["originalRunLookup"] != true {
		return nil, fail("operations_agentos_conversation_transport_unavailable", 503)
	}
	native, err := s.nativeOperation(ctx, row, parent)
	if err != nil {
		return nil, err
	}
	runID := text(native, "runId")
	if runID == "" {
		return nil, fail("operations_agentos_run_not_available", 409)
	}
	terminal := terminalConversation(native["status"])
	state := "dispatching"
	if terminal {
		state = text(native, "status")
	}
	receipt := Object{"operationId": operationID, "cancelledOperationId": parentID, "runId": runID, "state": state, "replayed": false}
	inserted, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		if _, err := s.Permissions.HumanAIWithin(ctx, tx, fresh, domain, "conversation", "workbench.read"); err != nil {
			return false, err
		}
		for _, key := range []string{s.Endpoint + ":conversation-cancel-parent:" + parentID, s.Endpoint + ":conversation:" + operationID} {
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", key); err != nil {
				return false, err
			}
		}
		var owner, conversation, priorDigest string
		err := tx.QueryRow(ctx, "SELECT operator_id,conversation_id::text,message_digest FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2", s.Endpoint, operationID).Scan(&owner, &conversation, &priorDigest)
		if err == nil {
			if owner != fresh.ID || conversation != row.ID || priorDigest != digest {
				return false, fail("operations_agentos_operation_conflict", 409)
			}
			return false, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
		var requested bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND result->>'cancelledOperationId'=$4)`, s.Endpoint, row.ID, fresh.ID, parentID).Scan(&requested); err != nil {
			return false, err
		}
		if requested {
			return false, fail("operations_agentos_cancel_already_requested", 409)
		}
		stored := "dispatching"
		if terminal {
			stored = "accepted"
		}
		_, err = tx.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, operationID, s.Endpoint, row.ID, operator.ID, digest, stored, receipt, runID, s.now())
		return true, err
	})
	if err != nil {
		return nil, err
	}
	if !inserted {
		return s.Operation(ctx, fresh, domain, operationID)
	}
	result := copyObject(receipt)
	if !terminal {
		again, cancelErr := s.fresh(ctx, fresh, authorize)
		if cancelErr == nil {
			_, cancelErr = s.Current(ctx, row.ID, &again)
		}
		if cancelErr == nil {
			_, cancelErr = s.Client.CancelConversation(ctx, row.Execution(), runID)
		}
		result["state"] = "accepted"
		if cancelErr != nil {
			result["state"] = "unknown"
		}
		if _, err = s.Pool.Exec(ctx, "UPDATE operations_agentos_conversation_commands_v1 SET state=$3,result=$4 WHERE endpoint=$1 AND id=$2", s.Endpoint, operationID, result["state"], result); err != nil {
			return nil, err
		}
	}
	final, err := s.fresh(ctx, fresh, authorize)
	if err != nil {
		return nil, err
	}
	if _, err = s.Current(ctx, row.ID, &final); err != nil {
		return nil, err
	}
	return result, nil
}
