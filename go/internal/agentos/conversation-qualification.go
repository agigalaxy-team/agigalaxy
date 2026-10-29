package agentos

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// ReadQualification rechecks the current human/fixed-AI reader and the original
// controlled sources without fetching native history, status, cards or effects.
// It proves current read eligibility, never that the history is unchanged.
func (s *Conversations) ReadQualification(ctx context.Context, operator operationspermissions.Actor, domain string) (Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	before, err := s.Session(ctx, operator, domain, false)
	if err != nil {
		return nil, err
	}
	var conversationID any
	deadline := s.now().Unix() + 30
	if before.Row != nil {
		current, err := s.Current(ctx, before.Row.ID, &operator)
		if err != nil {
			return nil, err
		}
		conversationID, deadline = current.Row.ID, current.ReadExpiresAt
	}
	// Recheck reader/assignment after source I/O. A different context requires
	// a fresh history read; it must not validate the former context's material.
	after, err := s.Session(ctx, operator, domain, false)
	if err != nil {
		return nil, err
	}
	if (before.Row == nil) != (after.Row == nil) || before.Row != nil && before.Row.ID != after.Row.ID {
		return nil, fail("operations_agentos_context_changed", 409)
	}
	at := s.now().Unix()
	if deadline <= at {
		return nil, fail("operations_agentos_source_qualification_unavailable", 503)
	}
	if limit := at + 30; deadline > limit {
		deadline = limit
	}
	return Object{"kind": "conversation-read-qualification", "metadataOnly": true, "domain": domain,
		"conversationId": conversationID, "contextChanged": false, "checkedAt": at, "readExpiresAt": deadline}, nil
}
