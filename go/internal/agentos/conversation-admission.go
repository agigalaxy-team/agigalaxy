package agentos

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type ConversationBusyError struct {
	OperationID, BlockingOperationID, ConversationID string
}

func (e *ConversationBusyError) Error() string { return "operations_agentos_conversation_busy" }
func (e *ConversationBusyError) Unwrap() error {
	return fail("operations_agentos_conversation_busy", 409)
}

// The caller holds the conversation-scoped transaction advisory lock. Do not
// call native or wait for a model while this transaction is held.
func (s *Conversations) requireConversationAvailableWithin(ctx context.Context, tx pgx.Tx, row Conversation, operationID string) error {
	var turn string
	err := tx.QueryRow(ctx, `SELECT c.id::text
      FROM operations_agentos_conversation_commands_v1 c
      WHERE c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3 AND c.id<>$4
        AND c.result->>'cancelledOperationId' IS NULL
        AND NOT (c.state='not-started' AND COALESCE(c.native_run_id,c.result->>'runId') IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM operations_autonomy_workbench_runs_v1 w
          JOIN operations_autonomy_tasks_v1 t ON t.endpoint=w.endpoint AND t.id=w.task_id
          WHERE w.endpoint=c.endpoint AND w.turn_operation_id=c.id
            AND w.native_run_id=COALESCE(c.native_run_id,c.result->>'runId')
            AND w.model_state IN ('completed','failed','cancelled')
            AND (w.task_id=c.id OR w.task_id::text=c.result->>'taskId')
            AND t.ai_account_id=$5 AND t.domain=$6
            AND t.configuration->'externalWorkbench'->>'conversationId'=$2::text
            AND t.configuration->'externalWorkbench'->>'operatorId'=$3
            AND t.configuration->'externalWorkbench'->>'turnOperationId'=c.id::text
        )
      ORDER BY c.created_at,c.id LIMIT 1`, s.Endpoint, row.ID, row.OperatorID, operationID, row.AIAccountID, row.Domain).Scan(&turn)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return &ConversationBusyError{OperationID: operationID, BlockingOperationID: turn, ConversationID: row.ID}
}
