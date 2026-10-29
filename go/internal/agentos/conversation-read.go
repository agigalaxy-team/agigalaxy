package agentos

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// ReadHistory has no health, card or management dependency. Native history and
// its own current source qualification are the only body/lease inputs.
func (s *Conversations) ReadHistory(ctx context.Context, human operationspermissions.Actor, domain string) (Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	before, err := s.readSession(ctx, human, domain)
	if err != nil {
		return nil, err
	}
	var native Object
	runs := []Object{}
	if before.Row != nil {
		if s.Client == nil {
			return nil, fail("operations_agentos_not_configured", 503)
		}
		value, err := s.Client.ReadConversation(ctx, before.Row.Execution())
		if err != nil {
			return nil, err
		}
		native = object(value)
		entries, _ := native["runs"].([]any)
		for _, entry := range entries {
			if run := object(entry); run != nil {
				runs = append(runs, run)
			}
		}
		runs, err = s.decorateRuns(ctx, *before.Row, runs)
		if err != nil {
			return nil, err
		}
		if s.SyncWorkbenchRuns != nil {
			if err = s.SyncWorkbenchRuns(ctx, *before.Row, runs); err != nil {
				return nil, err
			}
		}
	}
	current, err := s.finishConversationRead(ctx, human, domain, before)
	if err != nil {
		return nil, err
	}
	deadline := current.ReadExpiresAt
	if expiry, ok := index(native["readExpiresAt"]); ok && expiry < deadline {
		deadline = expiry
	}
	return Object{"domain": domain, "conversationId": readConversationID(current), "runs": runs, "contextChanged": current.ContextChanged, "checkedAt": s.now().Unix(), "readExpiresAt": deadline}, nil
}
