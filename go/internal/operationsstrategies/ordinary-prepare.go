package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) PrepareOrdinary(ctx context.Context, a Actor, kind string, input Object) (Object, error) {
	if kind == "create-draft" && !s.domain().IsDuty(a) {
		return nil, fail("operations_ai_duty_operation_denied", 403)
	}
	if !has([]string{"draft", "publish", "create-draft"}, kind) {
		return nil, invalid()
	}
	selectedID := input["strategyId"]
	if kind == "create-draft" {
		selectedID = input["sourceStrategyId"]
	}
	if !uuidPattern.MatchString(str(selectedID)) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, head, version, strategy, e := s.ordinaryInspect(ctx, tx, a, str(selectedID))
		if e != nil {
			return nil, e
		}
		if head["paused"] == true || head["active_id"] == nil || strategy["ordinaryBounds"] == nil || strategy["mode"] == "human-led" {
			return nil, fail("p13_ordinary_boundary_requires_human", 409)
		}
		command := Object{"expectedRevision": head["revision"], "strategyId": strategy["id"]}
		if kind == "create-draft" {
			if head["draft_id"] != nil {
				return nil, fail("p13_existing_draft_requires_human", 409)
			}
			if input["sourceVersionId"] != version["id"] || num(input["expectedRevision"]) != num(head["revision"]) {
				return nil, fail("p13_strategy_revision_changed", 409)
			}
			candidate := clone(input)
			delete(candidate, "kind")
			candidate["operationId"] = "00000000-0000-0000-0000-000000000000"
			x, e := ParseCommand("ordinary-create-draft", candidate)
			if e != nil {
				return nil, e
			}
			if _, e = OrdinaryCreation(obj(version["configuration"]), x, "ffffffff-ffff-ffff-ffff-ffffffffffff"); e != nil {
				return nil, e
			}
			command = clone(x)
			delete(command, "operationId")
		} else if kind == "draft" {
			if head["draft_id"] != nil {
				return nil, fail("p13_existing_draft_requires_human", 409)
			}
			edits := input["parameterEdits"]
			if edits == nil {
				edits = []any{}
			}
			candidate := Object{"operationId": "00000000-0000-0000-0000-000000000000", "expectedRevision": head["revision"], "strategyId": strategy["id"], "parameterEdits": edits}
			for _, k := range []string{"mode", "enabled"} {
				if v, ok := input[k]; ok {
					candidate[k] = v
				}
			}
			x, e := ParseCommand("ordinary-draft", candidate)
			if e != nil {
				return nil, e
			}
			if _, e = OrdinaryChanges(obj(version["configuration"]), x); e != nil {
				return nil, e
			}
			command["parameterEdits"] = x["parameterEdits"]
			for _, k := range []string{"mode", "enabled"} {
				if v, ok := x[k]; ok {
					command[k] = v
				}
			}
		} else {
			candidate, e := s.version(ctx, tx, input["versionId"])
			if e != nil {
				return nil, e
			}
			task, account, execution, e := s.ordinaryIdentity(actor)
			if e != nil {
				return nil, e
			}
			if !ordinarySameIdentity(candidate, actor, task, account, execution) || head["draft_id"] != candidate["id"] || candidate["ordinary_strategy_id"] != strategy["id"] || candidate["parent_id"] != version["id"] || has(texts(head["blocked_version_ids"]), str(candidate["id"])) {
				return nil, fail("p13_ordinary_draft_changed", 409)
			}
			command["versionId"] = candidate["id"]
		}
		if _, e = s.ordinaryActor(ctx, tx, a, str(strategy["id"]), "strategies.read", nil); e != nil {
			return nil, e
		}
		return s.metadata(Object{"command": command, "strategy": Object{"id": strategy["id"], "name": strategy["name"], "domain": strategy["domain"]}}), nil
	})
}
