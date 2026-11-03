package main

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

func strValue(v any) string { s, _ := v.(string); return s }

func connectWorkbenchDispatch(c *agentos.Conversations, s *operationsautonomy.Service) {
	c.Tools.ConfirmTaskDispatch = func(ctx context.Context, a operationspermissions.Actor, domain string, proposal agentos.Object, id string, authorize agentos.AuthorizeConversation) (agentos.Object, error) {
		return s.ConfirmDispatch(ctx, a, domain, proposal, id, operationsautonomy.Authorize(authorize))
	}
	c.Tools.ReadTaskDispatch = func(ctx context.Context, a operationspermissions.Actor, row agentos.Conversation, args agentos.Object) (agentos.Object, error) {
		return s.ReadDispatch(ctx, a, row.Domain, args)
	}
}
