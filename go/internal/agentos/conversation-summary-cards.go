package agentos

import (
	"context"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func completedSummaryReceipt(card *conversationCard) Object {
	value := card.Result
	if card.State != "completed" || value["state"] != "completed" || value["operationId"] != card.OperationID || object(value["receipt"])["operationId"] != card.OperationID {
		return nil
	}
	return value
}

// summaryCardBatch reads each selected card once. Completed effects are the
// immutable original receipts already recorded by confirmation/recovery; they
// never assert current source content or permission to perform another effect.
func (t *ConversationTools) summaryCardBatch(ctx context.Context, human operationspermissions.Actor, row *Conversation, cards, actions []*conversationCard, readers SummaryContextReaders) (map[string]Object, error) {
	batch := &cardReadBatch{tools: t, human: human, domain: row.Domain, permissions: map[string]cardReadPermission{}, actors: map[cardReadPermission]*cardReadActor{}}
	selected, seen := []*conversationCard{}, map[string]bool{}
	for _, values := range [][]*conversationCard{cards, actions} {
		for _, card := range values {
			if seen[card.ID] {
				continue
			}
			seen[card.ID] = true
			permission, err := t.cardReadPermission(text(card.Proposal, "kind"))
			if err != nil || row.AIAccountID == nil || card.OperatorID != human.ID || card.Domain != row.Domain {
				continue
			}
			purpose := "query"
			if card.Proposal["kind"] == "private-case-message" {
				purpose = "prepare"
			}
			batch.permissions[card.ID] = cardReadPermission{*row.AIAccountID, purpose, permission}
			selected = append(selected, card)
		}
	}
	if len(selected) == 0 {
		return map[string]Object{}, nil
	}
	values := make([]Object, len(selected))
	jobs := make(chan int)
	var workers sync.WaitGroup
	for range min(4, len(selected)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := range jobs {
				values[i] = t.summaryCard(ctx, selected[i], batch, readers)
			}
		}()
	}
	for i := range selected {
		jobs <- i
	}
	close(jobs)
	workers.Wait()
	// One current read projection per actually used account/purpose/action follows
	// all receipt/source I/O. The enclosing summary retains its separate final
	// fresh authority/version, conversation and controlled-source barriers.
	denied := map[cardReadPermission]bool{}
	_, err := postgres.InTx(ctx, t.Conversations.Pool, func(tx pgx.Tx) (bool, error) {
		for permission, entry := range batch.actors {
			if entry.err != nil {
				denied[permission] = true
				continue
			}
			if _, e := t.Conversations.Permissions.HumanAIAccountReadWithin(ctx, tx, human, row.Domain, permission.account, permission.purpose, permission.action); e != nil {
				if ctx.Err() != nil {
					return false, ctx.Err()
				}
				denied[permission] = true
			}
		}
		return true, nil
	})
	if err != nil {
		return nil, err
	}
	out := map[string]Object{}
	for i, card := range selected {
		if values[i] != nil && !denied[batch.permissions[card.ID]] {
			out[card.ID] = values[i]
		}
	}
	return out, nil
}

func (t *ConversationTools) summaryCard(ctx context.Context, card *conversationCard, batch *cardReadBatch, readers SummaryContextReaders) Object {
	actor, err := batch.actor(ctx, card)
	if err != nil {
		return nil
	}
	item := Object{"cardId": card.ID, "operationId": card.OperationID, "kind": card.Proposal["kind"], "currentRead": nil}
	if card.State == "prepared" {
		view, err := t.cardReadView(ctx, card, batch.actor, false)
		if err != nil {
			return nil
		}
		item["state"], item["canConfirm"], item["effectExecuted"] = view["state"], object(view["capability"])["canConfirm"], false
		return item
	}
	if card.Result["state"] == "cancelled" && card.Result["operationId"] == card.OperationID {
		item["state"], item["effectExecuted"] = "cancelled", false
		return item
	}
	original := completedSummaryReceipt(card)
	// Rehearsal receipts have a distinct identity contract and must be checked
	// against the owning service even if a stored projection has an operationId.
	if card.Proposal["kind"] == "strategy-rehearsal" {
		original = nil
	}
	if original == nil {
		if card.State != "processing" && card.State != "unknown" && card.State != "completed" {
			return nil
		}
		read := readers.OriginalOperation
		if read == nil {
			read = t.recoverPrepared
		}
		original, err = read(ctx, actor, card.Proposal, card.OperationID)
		if err != nil || original["operationId"] != card.OperationID {
			return nil
		}
		if original["state"] == "completed" {
			receipt := object(original["receipt"])
			// The exact owning recovery service validates the original selection.
			// Legacy safeReceipt shapes may omit their inner operationId; a
			// present inner ID must still match. Such incomplete stored receipts
			// are never reused above without this actual owning-service lookup.
			if receipt == nil || receipt["operationId"] != nil && receipt["operationId"] != card.OperationID {
				return nil
			}
		}
	}
	item["state"], item["summary"] = original["state"], original["summary"]
	item["recordedEffect"] = summaryRecordedEffect(original)
	if card.Proposal["kind"] == "strategy-rehearsal" && original["state"] == "completed" {
		receipt := object(original["receipt"])
		request := object(card.Proposal["request"])
		valid, validOK := receipt["valid"].(bool)
		if !validOK || overviewUUID(receipt["rehearsalId"]) == nil || receipt["rehearsalId"] != card.OperationID || overviewUUID(receipt["versionId"]) == nil || receipt["versionId"] != request["versionId"] {
			return nil
		}
		item["recordedEffect"] = Object{"rehearsalId": receipt["rehearsalId"], "versionId": receipt["versionId"], "valid": valid, "basis": "historical-original-rehearsal-not-current-publish-authorization"}
	}
	item["effectExecuted"] = nil
	if original["state"] == "completed" {
		item["effectExecuted"] = true
		if card.Proposal["kind"] == "strategy-rehearsal" {
			item["effectExecuted"] = false
		}
	}
	return item
}
