package agentos

import (
	"context"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

type cardReadPermission struct{ account, purpose, action string }
type cardReadActor struct {
	done  chan struct{}
	actor operationspermissions.Actor
	err   error
}

// This memo belongs to one bounded list request. It is not an authorization
// cache: each distinct action is checked and fresh barriers precede release.
type cardReadBatch struct {
	tools       *ConversationTools
	human       operationspermissions.Actor
	domain      string
	permissions map[string]cardReadPermission
	mu          sync.Mutex
	actors      map[cardReadPermission]*cardReadActor
}

func (b *cardReadBatch) actor(ctx context.Context, row *conversationCard) (operationspermissions.Actor, error) {
	permission, ok := b.permissions[row.ID]
	if !ok {
		return operationspermissions.Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	b.mu.Lock()
	entry, exists := b.actors[permission]
	if !exists {
		entry = &cardReadActor{done: make(chan struct{})}
		b.actors[permission] = entry
	}
	b.mu.Unlock()
	if !exists {
		s := b.tools.Conversations
		entry.actor, entry.err = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
			return s.Permissions.HumanAIAccountReadWithin(ctx, tx, b.human, b.domain, permission.account, permission.purpose, permission.action)
		})
		close(entry.done)
	} else {
		select {
		case <-entry.done:
		case <-ctx.Done():
			return operationspermissions.Actor{}, ctx.Err()
		}
	}
	return entry.actor, entry.err
}

// The list is a projection of already saved cards for the currently owned
// conversation. The confirmation endpoint still performs all live checks.
func (t *ConversationTools) readCardBatch(ctx context.Context, human operationspermissions.Actor, domain string, turns ...string) ([]Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	s := t.Conversations
	current, err := s.readSession(ctx, human, domain)
	if err != nil {
		return nil, err
	}
	out := []Object{}
	if current.Row == nil {
		return out, nil
	}
	query := `SELECT ` + conversationCardColumns + ` FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND domain=$4`
	args := []any{s.Endpoint, current.Row.ID, human.ID, domain}
	if len(turns) > 0 {
		query += ` AND turn_id=ANY($5::uuid[])`
		args = append(args, turns)
	}
	query += ` ORDER BY created_at DESC,id DESC`
	if len(turns) == 0 {
		query += ` LIMIT 30`
	}
	rows, err := s.Pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var row conversationCard
		if err = rows.Scan(cardScanFields(&row)...); err != nil {
			return nil, err
		}
		p := row.Proposal
		presentation := cardPresentation(p)
		attempted := cardAttempted(&row)
		canConfirm := row.State == "prepared" && !attempted && presentation["reviewable"] == true
		if p["kind"] == "ai-work-prompt-save" && object(p["review"]) == nil {
			canConfirm = false
		}
		capability := Object{"canConfirm": canConfirm, "canDismiss": row.State == "prepared" && p["dismissalAllowed"] == true && !attempted, "reason": nil}
		if presentation["reviewable"] != true {
			capability["reason"] = "presentation-review-unavailable"
		}
		target := p["target"]
		if p["kind"] == "recommendation-policy-save" {
			v := copyObject(object(target))
			v["label"] = "全站推荐策略"
			target = v
		}
		value := Object{"stored": true, "cardId": row.ID, "operationId": row.OperationID, "turnId": row.TurnID, "kind": p["kind"], "domain": row.Domain, "target": target, "title": presentation["summary"], "impact": []any{presentation["summary"]}, "basis": presentation["details"], "state": row.State, "result": cardPublicResult(row.Result), "capability": capability, "choice": p["choice"], "presentation": presentation, "confirmationAttempted": attempted, "feedbackEligible": attempted && row.Result["feedbackEnabled"] == true, "checkedAt": s.now().Unix()}
		if p["review"] != nil {
			value["review"] = p["review"]
		}
		out = append(out, value)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}
