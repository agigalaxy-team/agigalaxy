package agentos

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// ReadQualification renews only the current reader and conversation identity.
func (s *Conversations) ReadQualification(ctx context.Context, operator operationspermissions.Actor, domain string) (Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	before, err := s.readSession(ctx, operator, domain)
	if err != nil {
		return nil, err
	}
	current, err := s.finishConversationRead(ctx, operator, domain, before)
	if err != nil {
		return nil, err
	}
	return Object{"kind": "conversation-read-qualification", "metadataOnly": true, "domain": domain, "conversationId": readConversationID(current), "contextChanged": false, "checkedAt": s.now().Unix(), "readExpiresAt": current.ReadExpiresAt}, nil
}
