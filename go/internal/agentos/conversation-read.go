package agentos

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Conversations) ReadConversation(ctx context.Context, operator operationspermissions.Actor, domain string) (Object, error) {
	if !validConversationDomain(domain) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	current, err := s.Session(ctx, operator, domain, false)
	if err != nil {
		return nil, err
	}
	if s.Client == nil {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	status := s.Client.Status(ctx)
	version, _ := index(status["conversationVersion"])
	ready := (version == 1 || version == 2) && includesString(status["conversationDomains"], domain)
	var native Object
	if current.Row != nil {
		if status["state"] != "connected" {
			return nil, fail("operations_agentos_unavailable", 503)
		}
		if version != 1 && version != 2 {
			return nil, fail("operations_agentos_conversation_not_ready", 503)
		}
		value, err := s.Client.ReadConversation(ctx, current.Row.Execution())
		if err != nil {
			return nil, err
		}
		native = object(value)
	}
	if _, err = s.Session(ctx, operator, domain, false); err != nil {
		return nil, err
	}
	if current.Row != nil {
		if _, err = s.Current(ctx, current.Row.ID, &operator); err != nil {
			return nil, err
		}
	}
	cards := []Object{}
	if s.ToolCards != nil {
		cards, err = s.ToolCards(ctx, operator, domain)
		if err != nil {
			return nil, err
		}
	}
	runs := []Object{}
	if current.Row != nil {
		entries, _ := native["runs"].([]any)
		for _, entry := range entries {
			if run := object(entry); run != nil {
				runs = append(runs, run)
			}
		}
		runs, err = s.decorateRuns(ctx, *current.Row, runs)
		if err != nil {
			return nil, err
		}
		if _, err = s.Current(ctx, current.Row.ID, &operator); err != nil {
			return nil, err
		}
		if s.SyncWorkbenchRuns != nil {
			if err = s.SyncWorkbenchRuns(ctx, *current.Row, runs); err != nil {
				return nil, err
			}
		}
	}
	capabilities, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, err := s.Permissions.HumanAIWithin(ctx, tx, operator, domain, "query", "workbench.read")
		if err != nil {
			return nil, err
		}
		return s.Permissions.ManagementCapabilitiesWithin(ctx, tx, actor)
	})
	if err != nil {
		return nil, err
	}
	if _, err = s.Session(ctx, operator, domain, false); err != nil {
		return nil, err
	}
	configured := status["modelState"] == "configured"
	if domains, ok := status["configuredDomains"]; ok && !includesString(domains, domain) {
		configured = false
	}
	model := "not-configured"
	if configured {
		model = "configured"
	}
	if status["modelState"] == "unknown" {
		model = "unknown"
	}
	connected := status["state"] == "connected"
	var blocked any
	if !connected {
		blocked = "runtime-unavailable"
	} else if !configured {
		blocked = "model-not-configured"
	} else if !ready {
		blocked = "runtime-not-ready"
	}
	transport := object(status["conversationTransport"])
	expires := s.now().Unix() + 30
	if lease, ok := index(native["readExpiresAt"]); ok && lease < expires {
		expires = lease
	}
	for _, card := range cards {
		if lease, ok := index(card["readExpiresAt"]); ok && lease < expires {
			expires = lease
		}
	}
	return Object{"domain": domain, "runs": runs, "toolCards": cards, "contextChanged": current.ContextChanged, "runtimeState": status["state"], "managementCapabilities": capabilities, "modelState": model, "capabilities": Object{"canSend": connected && configured && ready, "canStream": connected && ready && transport["events"] == true && transport["originalRunLookup"] == true, "canCancel": connected && ready && transport["cancel"] == true && transport["originalRunLookup"] == true}, "blockedReason": blocked, "checkedAt": s.now().Unix(), "readExpiresAt": expires}, nil
}
