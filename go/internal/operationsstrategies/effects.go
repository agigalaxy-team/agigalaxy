package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

// EffectsAdapter consumes the same attested execution, current content consumer
// and original gateway receipt as an ordinary prepared command.
type EffectsAdapter struct {
	PoolReader          *Service
	Executions          *agentos.Executions
	Gateway             *agentos.ExecutionGateway
	Content             *operationscommunity.Service
	PriorPreparedEffect func(context.Context, string, string) (Object, error)
}

func (e *EffectsAdapter) ValidateRehearsalSampleWithin(ctx context.Context, tx pgx.Tx, id, owner string) error {
	if e == nil || e.Executions == nil {
		return fail("p13_effects_not_configured", 503)
	}
	_, _, err := e.Executions.CurrentPreparedWithin(ctx, tx, id, &owner)
	return err
}

func (e *EffectsAdapter) Inspect(ctx context.Context, id, owner string, conditions []Object) (Object, error) {
	if e == nil || e.PoolReader == nil {
		return nil, fail("p13_effects_not_configured", 503)
	}
	return postgres.InTx(ctx, e.PoolReader.Pool, func(tx pgx.Tx) (Object, error) { return e.InspectWithin(ctx, tx, id, owner, conditions) })
}
func (e *EffectsAdapter) InspectWithin(ctx context.Context, tx pgx.Tx, id, owner string, conditions []Object) (Object, error) {
	if e == nil || e.Executions == nil || e.Content == nil || e.Content.Forum == nil {
		return nil, fail("p13_effects_not_configured", 503)
	}
	var ownerID *string
	if owner != "" {
		ownerID = &owner
	}
	row, actor, err := e.Executions.CurrentPreparedWithin(ctx, tx, id, ownerID)
	if err != nil {
		return nil, err
	}
	command := row.PreparedCommand
	view, err := e.Content.ContentViewWithin(ctx, tx, actor, str(command["targetKind"]), str(command["targetId"]), len(conditions) > 0, true)
	if err != nil {
		return nil, err
	}
	var attachmentCount *int64
	hasConditions := false
	for _, s := range conditions {
		hasConditions = hasConditions || s["condition"] != nil
	}
	if hasConditions && view["sourceState"] == "available" {
		raw, err := e.Content.Forum.OperationsContentSourceWithin(ctx, tx, str(command["targetKind"]), str(command["targetId"]), false)
		if err != nil {
			return nil, err
		}
		if raw["available"] == true {
			n := int64(len(list(obj(raw["payload"])["attachments"])))
			attachmentCount = &n
		}
	}
	var text *string
	var links []any
	if view["sourceState"] == "available" {
		body, ok := view["body"].(string)
		if ok {
			text = &body
		}
		links = list(view["links"])
		if links == nil {
			links = []any{}
		}
	}
	facts := businessrules.ContentConditionFacts(text, links, attachmentCount)
	results := Object{}
	for _, strategy := range conditions {
		if strategy["condition"] == nil {
			results[str(strategy["id"])] = Object{"state": "not-applicable", "trace": nil}
			continue
		}
		trace, err := businessrules.EvaluateCondition(obj(strategy["condition"]), facts)
		if err != nil {
			return nil, err
		}
		results[str(strategy["id"])] = Object{"state": trace["state"], "trace": trace}
	}
	independent := true
	if err = e.Executions.CheckPriorDecisionWithin(ctx, tx, actor, command); err != nil {
		if fault.Code(err) != "operations_agentos_human_review_required" {
			return nil, err
		}
		independent = false
	}
	input := obj(command["input"])
	until := num(input["until"])
	maxHide := view["maxHideSeconds"]
	now := e.ExecutionsNow()
	temporal := input["kind"] == "restore" || integer(maxHide, -9007199254740991, 9007199254740991) && until > now && until <= now+num(maxHide)
	capability := "canRestore"
	action := "content.restore"
	if input["kind"] == "hide" {
		capability, action = "canHide", "content.hide"
	}
	return Object{"executionId": id, "ownerId": row.CreatedBy, "domain": row.Domain, "action": action, "target": Object{"kind": command["targetKind"], "id": command["targetId"]}, "sourceVersion": view["version"], "decisionRevision": obj(view["visibility"])["version"], "commandSourceVersion": input["expectedVersion"], "commandDecisionRevision": input["expectedRevision"], "grantId": row.GrantID, "grantVersion": row.GrantVersion, "executorKind": row.ExecutorKind, "grantMode": row.Mode, "conditionResults": results, "facts": Object{"authorized": true, "sourceAvailable": view["sourceState"] == "available" && obj(view["capabilities"])[capability] == true, "casMatches": same(view["version"], input["expectedVersion"]) && same(obj(view["visibility"])["version"], input["expectedRevision"]), "temporalAllowed": temporal, "independent": independent}}, nil
}
func (e *EffectsAdapter) ExecutionsNow() int64 {
	if e.PoolReader != nil {
		return e.PoolReader.now().Unix()
	}
	if e.Executions != nil && e.Executions.Now != nil {
		return e.Executions.Now().Unix()
	}
	return e.ContentNow()
}
func (e *EffectsAdapter) ContentNow() int64 {
	if e.Content != nil && e.Content.Now != nil {
		return e.Content.Now().Unix()
	}
	return time.Now().Unix()
}
func (e *EffectsAdapter) Execute(ctx context.Context, binding Object) (Object, error) {
	if e == nil || e.Gateway == nil {
		return nil, fail("p13_effects_not_configured", 503)
	}
	return e.Gateway.Execute(ctx, Object{"executionId": binding["execution_id"], "tool": "execute-prepared-command", "arguments": Object{}, "runId": binding["id"], "callId": "p13-prepared-effect"}, nil)
}
func (e *EffectsAdapter) PriorEffect(ctx context.Context, binding Object) (Object, error) {
	if e == nil || e.PriorPreparedEffect == nil {
		return nil, fail("p13_effects_not_configured", 503)
	}
	return e.PriorPreparedEffect(ctx, str(binding["execution_id"]), str(binding["id"]))
}
func (e *EffectsAdapter) Describe(ctx context.Context, id string) (Object, error) {
	if e == nil || e.PoolReader == nil || e.Executions == nil || e.Content == nil {
		return nil, fail("p13_effects_not_configured", 503)
	}
	return postgres.InTx(ctx, e.PoolReader.Pool, func(tx pgx.Tx) (Object, error) {
		row, actor, err := e.Executions.CurrentPreparedWithin(ctx, tx, id, nil)
		if err != nil {
			return nil, err
		}
		command := row.PreparedCommand
		item, err := e.Content.ContentViewWithin(ctx, tx, actor, str(command["targetKind"]), str(command["targetId"]), true, false)
		if err != nil {
			return nil, err
		}
		var title any
		if item["kind"] == "post" && item["sourceState"] == "available" {
			title = item["title"]
		}
		publishedUntil := e.PoolReader.now().Unix()
		if item["publishedUntil"] != nil {
			publishedUntil = num(item["publishedUntil"])
		}
		return Object{"title": title, "createdAt": iso(row.CreatedAt), "sourceExpiresAt": item["publishedUntil"], "commandUntil": obj(command["input"])["until"], "readExpiresAt": min(e.PoolReader.now().Unix()+30, publishedUntil)}, nil
	})
}
func (e *EffectsAdapter) ReadForAnalysis(ctx context.Context, binding Object) (Object, error) {
	if e == nil || e.Gateway == nil {
		return nil, fail("p13_effects_not_configured", 503)
	}
	return e.Gateway.Execute(ctx, Object{"executionId": binding["execution_id"], "tool": "read-selected-content", "arguments": Object{"kind": binding["target_kind"], "id": binding["target_id"]}, "runId": binding["id"], "callId": "p13-selected-source"}, nil)
}
