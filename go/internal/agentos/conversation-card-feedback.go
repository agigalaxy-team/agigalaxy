package agentos

import (
	"context"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
)

const feedbackMessage = "继续原任务：结合本次操作结果判断下一步，完成全部目标后再结束。不要重复执行原操作。"

func feedbackOperation(card *conversationCard) string {
	parent, err := uuid.Parse(card.OperationID)
	if err != nil {
		return ""
	}
	return uuid.NewSHA1(parent, []byte("confirmed-card-feedback-v1")).String()
}

func (t *ConversationTools) CardFeedback(ctx context.Context, human operationspermissions.Actor, domain, id string, start bool, authorize AuthorizeConversation) (Object, error) {
	card, err := t.ownedCard(ctx, human, domain, id)
	if err != nil {
		return nil, err
	}
	s := t.Conversations
	operation := feedbackOperation(card)
	old, err := s.command(ctx, operation)
	if err != nil {
		return nil, err
	}
	if old != nil {
		if old.Result["feedbackCardId"] != card.ID || old.Result["parentOperationId"] != card.TurnID || old.OperatorID != human.ID || old.ConversationID != card.ConversationID {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return s.Operation(ctx, human, domain, operation)
	}
	if !start {
		return Object{"operationId": operation, "runId": nil, "state": "not-started", "native": nil}, nil
	}
	if !cardAttempted(card) || card.Result["feedbackEnabled"] != true || (card.State != "completed" && card.State != "not-available") {
		return nil, fail("operations_agentos_feedback_not_ready", 409)
	}
	current, err := s.Session(ctx, human, domain, false)
	if err != nil {
		return nil, err
	}
	if current.Row == nil || current.Row.ID != card.ConversationID {
		return nil, fail("operations_agentos_context_changed", 409)
	}
	progress, _, err := s.conversationTaskContext(ctx, *current.Row, card.TurnID)
	if err != nil {
		return nil, err
	}
	// The root turn itself does not fetch its still-running input in authorize.
	// This feedback is a later run, so explicitly read the original native input.
	root := text(progress, "rootOperationId")
	rootCommand, err := s.command(ctx, root)
	if err != nil {
		return nil, err
	}
	if rootCommand == nil || rootCommand.ConversationID != card.ConversationID || rootCommand.OperatorID != human.ID {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	native, err := s.nativeOperation(ctx, *current.Row, rootCommand)
	if err != nil {
		return nil, err
	}
	objective := text(native, "userInput")
	if strings.TrimSpace(objective) == "" {
		return nil, fail("operations_agentos_task_objective_unavailable", 503)
	}
	// This server-authored continuation is associated with the original human
	// request. It does not reinterpret the receipt as a new user instruction.
	context := Object{"origin": "operation-feedback", "parentOperationId": card.TurnID, "logicalTurnId": root, "feedbackCardId": card.ID}
	input := Object{"operationId": operation, "message": feedbackMessage}
	parent, err := s.command(ctx, card.TurnID)
	if err != nil {
		return nil, err
	}
	if parent == nil || parent.ConversationID != card.ConversationID || parent.OperatorID != human.ID {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	if task := text(parent.Result, "taskId"); task != "" {
		input["taskId"] = task
	}
	return s.runWithContext(ctx, human, domain, input, authorize, context)
}

func (s *Conversations) receiptFeedback(ctx context.Context, row Conversation, command *conversationCommand) (Object, error) {
	id := text(command.Result, "feedbackCardId")
	if id == "" {
		return nil, nil
	}
	if s.Tools == nil || command.Result["origin"] != "operation-feedback" {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	card, err := readConversationCard(s.Pool.QueryRow(ctx, `SELECT `+conversationCardColumns+` FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4`, s.Endpoint, id, row.ID, row.OperatorID))
	if err != nil {
		return nil, err
	}
	if card == nil || card.TurnID != text(command.Result, "parentOperationId") || feedbackOperation(card) != command.ID || !cardAttempted(card) {
		return nil, fail("operations_agentos_scope_denied", 403)
	}
	current, err := s.CurrentRead(ctx, row.ID, nil)
	if err != nil {
		return nil, err
	}
	if _, err = s.Tools.cardActor(ctx, current.Actor, card); err != nil {
		return nil, err
	}
	var executed any
	if value, ok := card.Result["effectExecuted"].(bool); ok {
		executed = value
	}
	return Object{"cardId": card.ID, "operationId": card.OperationID, "parentTurnId": card.TurnID, "state": card.State, "effectExecuted": executed, "presentation": cardPresentation(card.Proposal), "receipt": Object{"state": card.Result["state"], "summary": card.Result["summary"]}}, nil
}
