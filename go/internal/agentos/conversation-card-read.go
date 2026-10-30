package agentos

import (
	"context"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
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

func (t *ConversationTools) readCardBatch(ctx context.Context, human operationspermissions.Actor, domain string, turns ...string) ([]Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	s := t.Conversations
	if _, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return s.Permissions.HumanAIReadWithin(ctx, tx, human, domain, "conversation", "workbench.read")
	}); err != nil {
		return nil, err
	}
	// Load whole cards and their original fixed-AI association in one bounded
	// query, rather than an ID query followed by per-card row/conversation reads.
	query := `SELECT c.id::text,c.conversation_id::text,c.turn_id::text,c.operator_id,c.domain,c.operation_id::text,c.state,c.proposal,c.result,c.created_at,c.updated_at,s.operator_id,s.domain,s.ai_account_id::text FROM operations_agentos_conversation_cards_v1 c JOIN operations_agentos_conversations_v1 s ON s.endpoint=c.endpoint AND s.id=c.conversation_id WHERE c.endpoint=$1 AND c.domain=$2 AND c.operator_id=$3`
	args := []any{s.Endpoint, domain, human.ID}
	if len(turns) > 0 {
		query += ` AND c.turn_id=ANY($4::uuid[])`
		args = append(args, turns)
	}
	query += ` ORDER BY c.created_at DESC,c.id DESC`
	if len(turns) == 0 {
		query += ` LIMIT 30`
	}
	rows, err := s.Pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	batch := &cardReadBatch{tools: t, human: human, domain: domain, permissions: map[string]cardReadPermission{}, actors: map[cardReadPermission]*cardReadActor{}}
	cards := []*conversationCard{}
	for rows.Next() {
		var row conversationCard
		var operator, originalDomain string
		var account *string
		fields := append(cardScanFields(&row), &operator, &originalDomain, &account)
		if err = rows.Scan(fields...); err != nil {
			rows.Close()
			return nil, err
		}
		if operator != human.ID || originalDomain != domain || account == nil {
			continue
		}
		action, e := t.cardReadPermission(text(row.Proposal, "kind"))
		if e != nil {
			rows.Close()
			return nil, e
		}
		purpose := "query"
		if row.Proposal["kind"] == "private-case-message" {
			purpose = "prepare"
		}
		batch.permissions[row.ID] = cardReadPermission{*account, purpose, action}
		cards = append(cards, &row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	values, failures := make([]Object, len(cards)), make([]error, len(cards))
	jobs := make(chan int)
	var workers sync.WaitGroup
	for range min(4, len(cards)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := range jobs {
				// Only processing/unknown cards recover their exact original
				// business receipt. Prepared cards recheck only their own source;
				// completed cards never poll a native conversation/history.
				values[i], failures[i] = t.readCard(ctx, human, cards[i], batch.actor, false)
			}
		}()
	}
	for i := range cards {
		jobs <- i
	}
	close(jobs)
	workers.Wait()
	for _, err := range failures {
		if err != nil && fault.Status(err) != 403 {
			return nil, err
		}
	}
	// Recheck every actually used account/purpose/action after all source and
	// receipt I/O. A withdrawn old card scope hides those cards, while loss of
	// the current domain/owner read permission rejects the entire list.
	denied := map[cardReadPermission]bool{}
	_, err = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		if _, e := s.Permissions.HumanAIWithin(ctx, tx, human, domain, "conversation", "workbench.read"); e != nil {
			return false, e
		}
		for permission, entry := range batch.actors {
			if entry.err != nil {
				denied[permission] = true
				continue
			}
			if _, e := s.Permissions.HumanAIAccountWithin(ctx, tx, human, domain, permission.account, permission.purpose, permission.action); e != nil {
				if fault.Status(e) != 403 {
					return false, e
				}
				denied[permission] = true
			}
		}
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	out := []Object{}
	for i := len(cards) - 1; i >= 0; i-- {
		if failures[i] == nil && !denied[batch.permissions[cards[i].ID]] && values[i] != nil {
			out = append(out, values[i])
		}
	}
	return out, nil
}
