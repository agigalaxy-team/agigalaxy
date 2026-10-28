package main

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

func connectWorkbenchActions(conversations *agentos.Conversations, autonomy *operationsautonomy.Service, content *operationscommunity.Service, files *filegovernance.Service) *actions.Service {
	service := &actions.Service{Pool: conversations.Pool, Endpoint: conversations.Endpoint, Permissions: conversations.Permissions,
		Autonomy: autonomy, Content: content, Files: files}
	tools := conversations.Tools
	tools.Prepare = func(ctx context.Context, actor p.Actor, row agentos.Conversation, request agentos.Object, operationID string) (agentos.Object, error) {
		return service.Prepare(ctx, actor, row.Domain, request, operationID)
	}
	tools.PrepareStored = func(ctx context.Context, actor p.Actor, row agentos.Conversation, proposal agentos.Object, operationID string) (agentos.Object, error) {
		request, _ := proposal["request"].(map[string]any)
		reference, _ := proposal["publicReference"].(map[string]any)
		return service.PrepareWithReference(ctx, actor, row.Domain, request, operationID, reference)
	}
	tools.CardReadPermission = actions.CardReadPermission
	tools.ExecutePrepared = service.ExecutePrepared
	tools.RecoverPrepared = service.RecoverPrepared
	autonomy.ActionReady = service.ActionReady
	autonomy.QualifyTargetWithin = service.QualifyTargetWithin
	autonomy.ExecuteDutyOperation = service.ExecuteDutyOperation
	priorSource := autonomy.PersistedSourceWithin
	autonomy.PersistedSourceWithin = func(ctx context.Context, tx pgx.Tx, metadata agentos.Object) (bool, error) {
		matched, err := service.PersistedSourceWithin(ctx, tx, metadata)
		if err != nil || matched || priorSource == nil {
			return matched, err
		}
		return priorSource(ctx, tx, metadata)
	}
	return service
}
