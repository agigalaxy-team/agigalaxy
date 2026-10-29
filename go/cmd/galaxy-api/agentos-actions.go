package main

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func connectWorkbenchActions(conversations *agentos.Conversations, autonomy *operationsautonomy.Service, content *operationscommunity.Service, files *filegovernance.Service) *actions.Service {
	service := &actions.Service{Pool: conversations.Pool, Endpoint: conversations.Endpoint, Permissions: conversations.Permissions,
		Autonomy: autonomy, Content: content, Files: files}
	tools := conversations.Tools
	tools.Prepare = func(ctx context.Context, actor p.Actor, row agentos.Conversation, request agentos.Object, operationID string) (agentos.Object, error) {
		return service.Prepare(ctx, actor, row.Domain, request, operationID)
	}
	tools.PrepareWithReference = func(ctx context.Context, actor p.Actor, row agentos.Conversation, request agentos.Object, operationID string, reference agentos.Object) (agentos.Object, error) {
		return service.PrepareWithReference(ctx, actor, row.Domain, request, operationID, reference)
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
	// checkTargetWithin owns the surrounding current read-authority checks.
	// These source readers use the same transaction and return no content.
	autonomy.ReadTargetWithin = func(ctx context.Context, tx pgx.Tx, actor p.Actor, _ string, kind, id string) (agentos.Object, error) {
		switch kind {
		case "feedback":
			if service.Feedback == nil {
				break
			}
			value, err := service.Feedback.HeadWithin(ctx, tx, id)
			if err != nil {
				return nil, err
			}
			if value["id"] != id {
				return nil, fault.New("operations_autonomy_source_unavailable", 503)
			}
			return agentos.Object{"availability": "available"}, nil
		case "post", "reply":
			if service.Content == nil || service.Content.Forum == nil {
				break
			}
			value, err := service.Content.ContentViewWithin(ctx, tx, actor, kind, id, false, false)
			if err != nil {
				return nil, err
			}
			if value["sourceState"] != "available" {
				return nil, fault.New("operations_autonomy_source_unavailable", 503)
			}
			return agentos.Object{"availability": "available"}, nil
		}
		return nil, fault.New("operations_autonomy_source_unavailable", 503)
	}
	autonomy.OriginalAIReceiptWithin = func(ctx context.Context, tx pgx.Tx, human p.Actor, src businessadmin.OriginalAIReceiptSource) (agentos.Object, error) {
		var err error
		src, err = normalizeOriginalAIReceiptSource(src)
		if err != nil {
			return nil, err
		}
		switch src.Request["kind"] {
		case "feedback-update":
			if service.Feedback != nil {
				return service.Feedback.OriginalAIReceiptWithin(ctx, tx, human, src)
			}
		case "content-visibility":
			if service.Content != nil {
				return service.Content.OriginalAIReceiptWithin(ctx, tx, human, src)
			}
		}
		return nil, fault.New("operations_autonomy_receipt_unavailable", 503)
	}
	autonomy.OriginalAIReceiptQueryWithin = func(ctx context.Context, tx pgx.Tx, actor p.Actor, authority p.Authority, src businessadmin.OriginalAIReceiptSource) (agentos.Object, error) {
		var err error
		src, err = normalizeOriginalAIReceiptSource(src)
		if err != nil {
			return nil, err
		}
		switch src.Request["kind"] {
		case "feedback-update":
			if service.Feedback != nil {
				return service.Feedback.OriginalAIReceiptQueryWithin(ctx, tx, actor, authority, src)
			}
		case "content-visibility":
			if service.Content != nil {
				return service.Content.OriginalAIReceiptQueryWithin(ctx, tx, actor, authority, src)
			}
		}
		return nil, fault.New("operations_autonomy_receipt_unavailable", 503)
	}
	tools.ReadTaskOperation = func(ctx context.Context, actor p.Actor, row agentos.Conversation, args agentos.Object) (agentos.Object, error) {
		if row.AIAccountID == nil || conversations.Permissions == nil {
			return nil, fault.New("operations_agentos_conversation_not_ready", 503)
		}
		taskID, _ := args["taskId"].(string)
		operationID, _ := args["operationId"].(string)
		return postgres.InTx(ctx, conversations.Pool, func(tx pgx.Tx) (agentos.Object, error) {
			queryActor, err := conversations.Permissions.HumanAIAccountReadWithin(ctx, tx, actor, row.Domain, *row.AIAccountID, "query", "autonomy.read")
			if err != nil {
				return nil, err
			}
			businessRead, err := autonomy.OriginalAIReceiptReadPermissionWithin(ctx, tx, taskID, operationID)
			if err != nil {
				return nil, err
			}
			return conversations.Permissions.WithOriginalAIReceiptReadWithin(ctx, tx, queryActor, businessRead, func(queryActor p.Actor, authority p.Authority) (agentos.Object, error) {
				result, err := autonomy.OriginalAIReceiptWithQueryWithin(ctx, tx, queryActor, authority, taskID, operationID)
				if err != nil {
					return nil, err
				}
				result["tool"], result["availability"], result["dataRead"], result["evidenceRefs"] = "read-task-operation", "available", true, []any{}
				return result, nil
			})
		})
	}
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

// normalizeOriginalAIReceiptSource compares the actual call against the exact
// parser used by its original execution. It does not accept caller input.
func normalizeOriginalAIReceiptSource(src businessadmin.OriginalAIReceiptSource) (businessadmin.OriginalAIReceiptSource, error) {
	request, err := actions.ParseRequest(src.CallArguments)
	if err != nil {
		return src, fault.New("operations_autonomy_operation_not_found", 404)
	}
	if src.Command != nil {
		current, e := identity.Canonical(request)
		original, f := identity.Canonical(src.Request)
		if e != nil || f != nil || string(current) != string(original) {
			return src, fault.New("operations_autonomy_operation_not_found", 404)
		}
	} else {
		src.Request = request
	}
	return src, nil
}
