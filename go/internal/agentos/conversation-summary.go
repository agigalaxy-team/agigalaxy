package agentos

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsqueries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// These readers are server-owned dependencies. They must read the original
// current source/receipt; model metadata is never an execution credential.
type SummaryContextReaders struct {
	BoundedTaskWithin func(context.Context, pgx.Tx, Conversation, Object) (Object, error)
	PriorAction       func(context.Context, operationspermissions.Actor, string, Object) (Object, error)
	OriginalOperation func(context.Context, operationspermissions.Actor, Object, string) (Object, error)
}

func (t *ConversationTools) summaryScope(ctx context.Context, a operationspermissions.Actor, domain string, bound Object) (*Conversation, *conversationCommand, error) {
	if t == nil || t.Conversations == nil || t.Conversations.Pool == nil {
		return nil, nil, fail("operations_agentos_conversation_not_ready", 503)
	}
	if len(bound) != 2 || !validOperationID(text(bound, "conversationId")) || !validOperationID(text(bound, "turnId")) {
		return nil, nil, fail("invalid_operations_agentos_request", 400)
	}
	current, e := t.Conversations.CurrentRead(ctx, text(bound, "conversationId"), &a)
	if e != nil {
		return nil, nil, e
	}
	if current.Row.Domain != domain {
		return nil, nil, fail("operations_agentos_domain_mismatch", 403)
	}
	command, e := t.Conversations.command(ctx, text(bound, "turnId"))
	if e != nil {
		return nil, nil, e
	}
	if command == nil || command.ConversationID != current.Row.ID || command.OperatorID != a.ID {
		return nil, nil, fail("operations_agentos_scope_denied", 403)
	}
	return current.Row, command, nil
}

// RecheckContext only revalidates the same current owner, fixed AI and turn.
func (t *ConversationTools) RecheckContext(ctx context.Context, a operationspermissions.Actor, domain string, bound Object) error {
	_, _, e := t.summaryScope(ctx, a, domain, bound)
	return e
}

func (t *ConversationTools) SummaryContext(ctx context.Context, a operationspermissions.Actor, domain string, bound Object, readers SummaryContextReaders) (Object, error) {
	row, command, e := t.summaryScope(ctx, a, domain, bound)
	if e != nil {
		return nil, e
	}
	prior, e := t.priorSummaryReads(ctx, a, row, command)
	if e != nil {
		return nil, e
	}
	currentReads, e := t.currentSummaryReads(ctx, a, row, command)
	if e != nil {
		return nil, e
	}
	turns, e := t.summaryTurnOutcomes(ctx, row, command)
	if e != nil {
		return nil, e
	}
	var task Object
	if id := text(command.Result, "taskId"); id != "" {
		if !validOperationID(id) {
			return nil, fail("operations_agentos_scope_denied", 403)
		}
		if readers.BoundedTaskWithin == nil {
			return nil, fail("operations_agentos_conversation_not_ready", 503)
		}
		task, e = postgres.InTx(ctx, t.Conversations.Pool, func(tx pgx.Tx) (Object, error) {
			fresh, e := t.Conversations.CurrentReadWithin(ctx, tx, row.ID, &a)
			if e != nil {
				return nil, e
			}
			return readers.BoundedTaskWithin(ctx, tx, *fresh.Row, Object{"id": command.ID, "result": command.Result})
		})
		if e != nil {
			return nil, e
		}
		if task == nil {
			return nil, fail("operations_agentos_conversation_not_ready", 503)
		}
	}
	cards, e := t.summaryCards(ctx, a, row, command, false)
	if e != nil {
		return nil, e
	}
	actionCards, e := t.summaryCards(ctx, a, row, command, true)
	if e != nil {
		return nil, e
	}
	observed, e := t.summaryCardBatch(ctx, a, row, cards, actionCards, readers)
	if e != nil {
		return nil, e
	}
	operations := t.priorSummaryOperations(cards, observed)
	actions, e := t.priorSummaryActions(ctx, a, row, command, readers, actionCards, observed)
	if e != nil {
		return nil, e
	}
	if e = t.RecheckContext(ctx, a, domain, bound); e != nil {
		return nil, e
	}
	return Object{"priorReadReceipts": prior, "currentReadOutcomes": currentReads, "turnOutcomes": turns, "boundedTask": task, "priorActionReceipts": actions, "priorOperationReceipts": operations}, nil
}

func (t *ConversationTools) priorSummaryReads(ctx context.Context, a operationspermissions.Actor, row *Conversation, command *conversationCommand) (Object, error) {
	rows, e := t.Conversations.Pool.Query(ctx, `WITH previous_turns AS (SELECT id FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND created_at<$4 ORDER BY created_at DESC,id DESC LIMIT 10) SELECT t.tool,t.state,t.metadata,t.created_at,t.updated_at FROM operations_agentos_conversation_tool_calls_v1 t JOIN previous_turns p ON p.id=t.turn_id WHERE t.endpoint=$1 AND t.conversation_id=$2 AND t.tool IN ('workbench-summary','query-operations','read-operation-object','read-ai-delegation') ORDER BY t.created_at DESC,t.id DESC LIMIT 80`, t.Conversations.Endpoint, row.ID, a.ID, command.CreatedAt)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var tool, state string
		var metadata Object
		var created time.Time
		var updated *time.Time
		if e = rows.Scan(&tool, &state, &metadata, &created, &updated); e != nil {
			return nil, e
		}
		if updated != nil {
			created = *updated
		}
		if item := operationsqueries.PriorReadReceipt(tool, state, metadata, created); item != nil {
			items = append(items, item)
		}
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	slices.Reverse(items)
	return Object{"basis": "current-conversation-prior-read-ledger", "valuesCurrent": false, "items": items}, nil
}

// Current-turn tool receipts are independent of historical turn receipts.
func (t *ConversationTools) currentSummaryReads(ctx context.Context, a operationspermissions.Actor, row *Conversation, command *conversationCommand) (Object, error) {
	rows, e := t.Conversations.Pool.Query(ctx, `SELECT tool,state,metadata,created_at,updated_at FROM operations_agentos_conversation_tool_calls_v1 WHERE endpoint=$1 AND conversation_id=$2 AND turn_id=$3 AND tool IN ('workbench-summary','query-operations','read-operation-object','read-ai-delegation') AND NOT (tool='workbench-summary' AND state='started') ORDER BY created_at,id LIMIT 80`, t.Conversations.Endpoint, row.ID, command.ID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var tool, state string
		var metadata Object
		var created time.Time
		var updated *time.Time
		if e = rows.Scan(&tool, &state, &metadata, &created, &updated); e != nil {
			return nil, e
		}
		if updated != nil {
			created = *updated
		}
		if item := operationsqueries.PriorReadReceipt(tool, state, metadata, created); item != nil {
			items = append(items, item)
		}
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	return Object{"basis": "same-owner-current-turn-tool-ledger", "valuesCurrent": false, "items": items}, nil
}

func (t *ConversationTools) summaryCards(ctx context.Context, a operationspermissions.Actor, row *Conversation, command *conversationCommand, actions bool) ([]*conversationCard, error) {
	extra := ""
	if actions {
		extra = ` AND c.state='completed' AND c.proposal->>'kind' IN ('content-visibility','content-curation','feedback-update','account-restriction') AND c.updated_at<=$5`
	}
	columns := []string{}
	for _, c := range strings.Split(conversationCardColumns, ",") {
		columns = append(columns, "c."+c)
	}
	rows, e := t.Conversations.Pool.Query(ctx, `SELECT `+strings.Join(columns, ",")+` FROM operations_agentos_conversation_cards_v1 c JOIN operations_agentos_conversations_v1 s ON s.id=c.conversation_id AND s.endpoint=c.endpoint WHERE c.endpoint=$1 AND c.operator_id=$2 AND c.domain=$3 AND s.operator_id=$2 AND s.domain=$3 AND s.ai_account_id=$4 AND c.created_at<=$5`+extra+` ORDER BY c.created_at DESC,c.id DESC LIMIT 20`, t.Conversations.Endpoint, a.ID, row.Domain, row.AIAccountID, command.CreatedAt)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []*conversationCard{}
	for rows.Next() {
		card, e := readConversationCard(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, card)
	}
	return out, rows.Err()
}
func (t *ConversationTools) priorSummaryActions(ctx context.Context, a operationspermissions.Actor, row *Conversation, command *conversationCommand, r SummaryContextReaders, cards []*conversationCard, observed map[string]Object) (Object, error) {
	at := t.Conversations.now().Unix()
	out := Object{"basis": "same-owner-current-fixed-ai-completed-action-ledger", "scope": "latest-20-completed-content-feedback-and-account-cards", "absenceMeaning": "not-evidence-of-no-previous-effect", "valuesCurrent": false, "availability": "available", "items": []any{}, "checkedAt": at, "readExpiresAt": at + 30}
	if len(cards) > 0 && r.PriorAction != nil {
		return r.PriorAction(ctx, a, row.Domain, Object{"conversationId": row.ID, "turnId": command.ID})
	}
	// A completed card alone is not proof of an effect, nor permission to
	// replay its old source prose. Missing/withdrawn individual receipts only
	// narrow this projection, never fabricate a successful or empty history.
	items := []any{}
	for _, card := range cards {
		original := observed[card.ID]
		if original == nil || original["operationId"] != card.OperationID || original["state"] != "completed" || original["effectExecuted"] != true {
			out["availability"] = "partial"
			continue
		}
		reference := priorActionReference(card.Proposal)
		if reference == nil {
			out["availability"] = "partial"
			continue
		}
		items = append(items, Object{"cardId": card.ID, "operationId": card.OperationID, "kind": card.Proposal["kind"], "state": "completed", "effectExecuted": true, "recordedEffect": original["recordedEffect"], "reference": reference, "currentRead": nil})
	}
	out["items"] = items
	at = t.Conversations.now().Unix()
	out["checkedAt"], out["readExpiresAt"] = at, at+30
	return out, nil
}

// Only a server-persisted request whose exact original receipt was verified can
// supply this locator. It deliberately has no old title, excerpt or source lease;
// the ordinary object-read tool must still establish current source eligibility.
func priorActionReference(proposal Object) Object {
	request := object(proposal["request"])
	if request["kind"] != proposal["kind"] || !validOperationID(text(request, "targetId")) {
		return nil
	}
	kind := ""
	switch text(proposal, "kind") {
	case "content-visibility", "content-curation":
		kind = text(request, "targetKind")
		if kind != "post" && kind != "reply" {
			return nil
		}
	case "feedback-update":
		kind = "feedback"
	case "account-restriction":
		kind = "account"
	default:
		return nil
	}
	arguments := Object{"kind": kind, "id": request["targetId"], "filters": Object{}}
	return Object{"kind": kind, "id": request["targetId"], "read": Object{"tool": "read-operation-object", "arguments": arguments}}
}

func summaryRecordedEffect(original Object) Object {
	effect := Object{}
	for key, value := range object(original["receipt"]) {
		if slices.Contains(strings.Fields("operationId phase state version revision publishedVersion themeKey direction enabled hidden planId strategyId versionId feedbackId accountId reportId messageId action"), key) {
			switch value.(type) {
			case nil, string, bool, float64, int, int64:
				effect[key] = value
			}
		}
	}
	return effect
}
func (t *ConversationTools) priorSummaryOperations(cards []*conversationCard, observed map[string]Object) Object {
	at := t.Conversations.now().Unix()
	items := []any{}
	out := Object{"basis": "same-owner-fixed-ai-original-domain-receipts", "valuesCurrent": false, "availability": "available", "items": items, "checkedAt": at, "readExpiresAt": at + 30}
	for _, card := range cards {
		item := observed[card.ID]
		if item == nil {
			out["availability"] = "partial"
			continue
		}
		items = append(items, item)
	}
	out["items"] = items
	at = t.Conversations.now().Unix()
	out["checkedAt"], out["readExpiresAt"] = at, at+30
	return out
}
