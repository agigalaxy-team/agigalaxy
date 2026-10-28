package agentos

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func parseCardConfirmation(id string, input Object) (string, error) {
	if len(input) != 2 || input["cardId"] != id || !validOperationID(id) || !validOperationID(text(input, "operationId")) {
		return "", fail("invalid_operations_agentos_request", 400)
	}
	return text(input, "operationId"), nil
}

func (t *ConversationTools) Confirm(ctx context.Context, human operationspermissions.Actor, domain, id string, input Object, authorize AuthorizeConversation) (Object, error) {
	operationID, err := parseCardConfirmation(id, input)
	if err != nil {
		return nil, err
	}
	s := t.Conversations
	fresh, err := s.fresh(ctx, human, authorize)
	if err != nil {
		return nil, err
	}
	row, err := t.ownedCard(ctx, fresh, domain, id)
	if err != nil {
		return nil, err
	}
	if row.OperationID != operationID {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	_, err = t.cardActor(ctx, fresh, row)
	if err != nil {
		return nil, err
	}
	_, err = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return s.Permissions.HumanAIWithin(ctx, tx, fresh, domain, "prepare", text(row.Proposal, "requiredAction"))
	})
	if err != nil {
		return nil, err
	}
	if row.State == "completed" {
		return t.cardView(ctx, fresh, row)
	}
	if row.State == "processing" || row.State == "unknown" {
		return t.Card(ctx, fresh, domain, id)
	}
	view, err := t.cardView(ctx, fresh, row)
	if err != nil {
		return nil, err
	}
	if object(view["capability"])["canConfirm"] != true {
		return nil, fail("operations_agentos_proposal_changed", 409)
	}
	at := s.now()
	claimed, err := readConversationCard(s.Pool.QueryRow(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET state='processing',result=jsonb_build_object('operationId',operation_id,'state','processing','summary','正在处理…','confirmationAttemptedAt',to_jsonb($3::timestamptz)),updated_at=$3 WHERE endpoint=$1 AND id=$2 AND state='prepared' AND NOT (proposal ? 'confirmationAttemptedAt') AND (result IS NULL OR NOT (result ? 'confirmationAttemptedAt')) RETURNING `+conversationCardColumns, s.Endpoint, id, at))
	if err != nil {
		return nil, err
	}
	if claimed == nil {
		return t.Card(ctx, fresh, domain, id)
	}
	row = claimed
	scopedAuthorize := func(ctx context.Context) (operationspermissions.Actor, error) {
		current, err := s.fresh(ctx, human, authorize)
		if err != nil {
			return operationspermissions.Actor{}, err
		}
		bound, err := t.cardActor(ctx, current, row)
		if err != nil {
			return operationspermissions.Actor{}, err
		}
		if err = t.assertCardBound(ctx, row); err != nil {
			return operationspermissions.Actor{}, err
		}
		return bound, nil
	}
	current, err := scopedAuthorize(ctx)
	var result Object
	if err == nil {
		if _, management := managementCardRead(text(row.Proposal, "kind")); management == nil {
			result, err = s.Permissions.ExecuteManagementAction(ctx, current, row.Proposal, operationID, scopedAuthorize)
		} else if t.ExecutePrepared != nil {
			result, err = t.ExecutePrepared(ctx, current, row.Proposal, operationID, func(ctx context.Context, _ pgx.Tx) (operationspermissions.Actor, error) { return scopedAuthorize(ctx) })
		} else {
			err = fail("operations_agentos_conversation_not_ready", 503)
		}
	}
	state := "unknown"
	if err != nil {
		status := fault.Status(err)
		summary := "正在查询这次处理的原结果。"
		if status == 400 || status == 403 || status == 404 || status == 409 {
			state = "not-available"
			summary = "当前条件已变化，本次处理未继续。"
		}
		result = Object{"operationId": operationID, "state": state, "summary": summary, "code": fault.Code(err)}
	} else {
		switch result["state"] {
		case "completed", "processing", "unknown":
			state = text(result, "state")
		default:
			state = "not-available"
		}
	}
	result = copyObject(result)
	if attempt, ok := row.Result["confirmationAttemptedAt"]; ok {
		result["confirmationAttemptedAt"] = attempt
	}
	row, err = readConversationCard(s.Pool.QueryRow(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING `+conversationCardColumns, s.Endpoint, id, state, result, s.now()))
	if err != nil {
		return nil, err
	}
	fresh, err = s.fresh(ctx, human, authorize)
	if err != nil {
		return nil, err
	}
	// The immutable delegated-management receipt owns completion, not the model.
	return t.cardView(ctx, fresh, row)
}

func (t *ConversationTools) Dismiss(ctx context.Context, human operationspermissions.Actor, domain, id string, input Object, authorize AuthorizeConversation) (Object, error) {
	operationID, err := parseCardConfirmation(id, input)
	if err != nil {
		return nil, err
	}
	s := t.Conversations
	fresh, err := s.fresh(ctx, human, authorize)
	if err != nil {
		return nil, err
	}
	row, err := t.ownedCard(ctx, fresh, domain, id)
	if err != nil {
		return nil, err
	}
	if row.OperationID != operationID {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	if row.State == "prepared" && (row.Proposal["dismissalAllowed"] != true || cardAttempted(row)) {
		return nil, fail("operations_agentos_card_dismissal_unavailable", 409)
	}
	result := Object{"operationId": operationID, "state": "cancelled", "summary": "已取消，未执行处理。"}
	changed, err := readConversationCard(s.Pool.QueryRow(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET state='not-available',result=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2 AND state='prepared' AND proposal->>'dismissalAllowed'='true' AND NOT (proposal ? 'confirmationAttemptedAt') AND (result IS NULL OR NOT (result ? 'confirmationAttemptedAt')) RETURNING `+conversationCardColumns, s.Endpoint, id, result, s.now()))
	if err != nil {
		return nil, err
	}
	fresh, err = s.fresh(ctx, human, authorize)
	if err != nil {
		return nil, err
	}
	if changed != nil {
		row = changed
	} else {
		row, err = t.ownedCard(ctx, fresh, domain, id)
		if err != nil {
			return nil, err
		}
	}
	return t.cardView(ctx, fresh, row)
}
