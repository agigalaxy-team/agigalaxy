package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// OrdinaryChanges reconstructs only the human-approved numeric/mode/enable edits.
func OrdinaryChanges(configuration, input Object) (Object, error) {
	config := deepClone(configuration)
	strategy := findStrategy(config, input["strategyId"])
	bounds := obj(strategy["ordinaryBounds"])
	if strategy == nil || bounds == nil || !has([]string{"selected-public-content-visibility", "business-action", "analysis-only"}, str(strategy["template"])) || strategy["mode"] == "human-led" {
		return nil, fail("p13_ordinary_boundary_requires_human", 409)
	}
	seen := map[string]bool{}
	for _, v := range list(input["parameterEdits"]) {
		edit := obj(v)
		key := pathKey(edit["path"])
		if seen[key] {
			return nil, invalid()
		}
		seen[key] = true
		var bound Object
		for _, v := range list(bounds["parameters"]) {
			if same(obj(v)["path"], edit["path"]) {
				bound = obj(v)
				break
			}
		}
		node := leaf(strategy["condition"], edit["path"])
		if bound == nil || node == nil || !integer(node["value"], 0, 9007199254740991) || num(edit["value"]) < num(bound["minimum"]) || num(edit["value"]) > num(bound["maximum"]) {
			return nil, fail("p13_ordinary_parameter_requires_human", 409)
		}
		node["value"] = edit["value"]
	}
	if mode, ok := input["mode"]; ok {
		if !has(texts(bounds["modes"]), str(mode)) || mode == "human-led" {
			return nil, fail("p13_ordinary_mode_requires_human", 409)
		}
		strategy["mode"] = mode
		if x := obj(strategy["execution"]); x != nil {
			x["mode"] = map[string]string{"code-automatic": "code", "ai-autonomous": "ai", "ai-human-participation": "ai-human"}[str(mode)]
		}
	}
	if enabled, ok := input["enabled"]; ok {
		if enabled == true && bounds["canEnable"] != true || enabled == false && bounds["canDisable"] != true {
			return nil, fail("p13_ordinary_enable_requires_human", 409)
		}
		strategy["enabled"] = enabled
	}
	return ParseConfiguration(config)
}

// OrdinaryCreation derives a new strategy only from a current human-approved
// template. It cannot change goals, action/target/grant boundaries or recursively
// authorize further creation.
func OrdinaryCreation(configuration, input Object, newID string) (Object, error) {
	if !uuidPattern.MatchString(newID) || findStrategy(configuration, newID) != nil {
		return nil, invalid()
	}
	source := findStrategy(configuration, input["sourceStrategyId"])
	if source == nil || obj(source["ordinaryBounds"])["canCreate"] != true {
		return nil, fail("p13_ordinary_boundary_requires_human", 409)
	}
	edits := Object{"strategyId": input["sourceStrategyId"], "parameterEdits": input["parameterEdits"]}
	for _, key := range []string{"mode", "enabled"} {
		if v, ok := input[key]; ok {
			edits[key] = v
		}
	}
	adjusted, err := OrdinaryChanges(configuration, edits)
	if err != nil {
		return nil, err
	}
	created := deepClone(findStrategy(adjusted, input["sourceStrategyId"]))
	created["id"], created["name"] = newID, input["name"]
	obj(created["ordinaryBounds"])["canCreate"] = false
	result := deepClone(configuration)
	result["strategies"] = append(list(result["strategies"]), created)
	return ParseConfiguration(result)
}

type OrdinaryExecutor interface {
	AcceptsExecutor(Actor) bool
	RequireSelectedWithin(context.Context, pgx.Tx, Actor, string, string, Object) (Actor, error)
	ExecutorMetadata(Actor) (Object, error)
}

func (s *Service) ordinaryActor(ctx context.Context, tx pgx.Tx, a Actor, id, action string, input Object) (Actor, error) {
	d := s.domain()
	if d.IsDuty(a) {
		duty := d.DutyAuthority()
		if action == "strategies.read" {
			return duty.RequireDutyAction(ctx, tx, a, action, "")
		}
		selection := Object{"id": id}
		for k, v := range input {
			selection[k] = v
		}
		return duty.RequireDutyOperation(ctx, tx, a, []string{action}, selection, &action)
	}
	if s.Executor != nil && s.Executor.AcceptsExecutor(a) {
		return s.Executor.RequireSelectedWithin(ctx, tx, a, action, id, input)
	}
	if a.AIProof != nil && !s.acceptsPreparation(a) && action != "strategies.read" {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if s.Authority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return s.Authority.RequireWithin(ctx, tx, a, action)
}
func (s *Service) ordinaryIdentity(a Actor) (taskID, accountID, executionID any, err error) {
	if s.domain().IsDuty(a) {
		metadata, e := s.domain().DutyAuthority().DutyMetadata(a)
		if e != nil {
			return nil, nil, nil, e
		}
		return metadata["taskId"], metadata["aiAccountId"], nil, nil
	}
	if s.Executor != nil && s.Executor.AcceptsExecutor(a) {
		metadata, e := s.Executor.ExecutorMetadata(a)
		if e != nil {
			return nil, nil, nil, e
		}
		return nil, nil, metadata["executionId"], nil
	}
	return nil, nil, nil, nil
}
func ordinarySameIdentity(candidate Object, a Actor, taskID, accountID, executionID any) bool {
	if candidate == nil {
		return false
	}
	if taskID != nil {
		return candidate["ordinary_task_id"] == taskID && candidate["ordinary_ai_account_id"] == accountID
	}
	if executionID != nil {
		return candidate["ordinary_execution_id"] == executionID
	}
	return candidate["created_by"] == a.ID && candidate["ordinary_task_id"] == nil && candidate["ordinary_execution_id"] == nil
}
func (s *Service) ordinaryInspect(ctx context.Context, tx pgx.Tx, a Actor, id string) (Actor, Object, Object, Object, error) {
	actor, e := s.ordinaryActor(ctx, tx, a, id, "strategies.read", nil)
	if e != nil {
		return Actor{}, nil, nil, nil, e
	}
	head, e := s.head(ctx, tx)
	if e != nil {
		return Actor{}, nil, nil, nil, e
	}
	version, e := s.version(ctx, tx, head["active_id"])
	if e != nil {
		return Actor{}, nil, nil, nil, e
	}
	strategy := findStrategy(obj(version["configuration"]), id)
	if strategy == nil {
		return Actor{}, nil, nil, nil, fail("p13_strategy_not_found", 404)
	}
	return actor, head, version, strategy, nil
}
func (s *Service) ReadOrdinary(ctx context.Context, a Actor, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		_, head, version, strategy, e := s.ordinaryInspect(ctx, tx, a, id)
		if e != nil {
			return nil, e
		}
		draft, e := s.version(ctx, tx, head["draft_id"])
		if e != nil {
			return nil, e
		}
		if _, e = s.ordinaryActor(ctx, tx, a, id, "strategies.read", nil); e != nil {
			return nil, e
		}
		var draftView any
		if draft != nil {
			draftView = Object{"id": draft["id"], "version": draft["version"], "strategyId": draft["ordinary_strategy_id"], "createdBy": draft["created_by"], "executionId": draft["ordinary_execution_id"], "taskId": draft["ordinary_task_id"], "aiAccountId": draft["ordinary_ai_account_id"]}
		}
		var objective any
		for _, v := range list(obj(version["configuration"])["domains"]) {
			if obj(v)["key"] == strategy["domain"] {
				objective = obj(v)["objective"]
			}
		}
		return s.metadata(Object{"revision": head["revision"], "versionId": version["id"], "strategy": strategy, "draft": draftView, "goals": Object{"common": obj(obj(version["configuration"])["common"])["objective"], "domain": objective}}), nil
	})
}
func (s *Service) OrdinaryOperation(ctx context.Context, a Actor, strategyID, operationID string) (Object, error) {
	if !uuidPattern.MatchString(strategyID) || !uuidPattern.MatchString(operationID) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.ordinaryActor(ctx, tx, a, strategyID, "strategies.read", nil)
		if e != nil {
			return nil, e
		}
		row, e := one(ctx, tx, `SELECT to_jsonb(c) FROM operations_p13_strategy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return s.metadata(Object{"state": "not-recorded", "operationId": operationID}), nil
		}
		if row["operator_id"] != actor.ID || obj(row["result"])["strategyId"] != strategyID {
			return nil, fail("p13_operation_not_found", 404)
		}
		if _, e = s.ordinaryActor(ctx, tx, a, strategyID, "strategies.read", nil); e != nil {
			return nil, e
		}
		result := clone(obj(row["result"]))
		result["replayed"] = true
		return s.metadata(Object{"state": "recorded", "operationId": operationID, "kind": row["kind"], "input": row["input"], "result": result}), nil
	})
}
func (s *Service) CommandOrdinary(ctx context.Context, a Actor, kind string, input Object) (Object, error) {
	if kind == "create-draft" && !s.domain().IsDuty(a) {
		return nil, fail("operations_ai_duty_operation_denied", 403)
	}
	if !has([]string{"draft", "publish", "create-draft"}, kind) {
		return nil, invalid()
	}
	x, e := ParseCommand("ordinary-"+kind, input)
	if e != nil {
		return nil, e
	}
	action := "strategies.ordinary.publish"
	if kind == "draft" || kind == "create-draft" {
		action = "strategies.ordinary.configure"
	}
	strategyID := str(x["strategyId"])
	if kind == "create-draft" {
		strategyID = str(x["sourceStrategyId"])
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.lock(ctx, tx, ""); e != nil {
			return nil, e
		}
		if e := s.lock(ctx, tx, "operation:"+str(x["operationId"])); e != nil {
			return nil, e
		}
		actor, e := s.ordinaryActor(ctx, tx, a, strategyID, action, x)
		if e != nil {
			return nil, e
		}
		taskID, accountID, executionID, e := s.ordinaryIdentity(actor)
		if e != nil {
			return nil, e
		}
		old, e := one(ctx, tx, `SELECT to_jsonb(c) FROM operations_p13_strategy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, x["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if old["operator_id"] != actor.ID || old["kind"] != "ordinary-"+kind || !same(old["input"], x) {
				return nil, fail("p13_operation_conflict", 409)
			}
			out := clone(obj(old["result"]))
			out["replayed"] = true
			return out, nil
		}
		head, e := s.head(ctx, tx)
		if e != nil {
			return nil, e
		}
		if num(head["revision"]) != num(x["expectedRevision"]) {
			return nil, fail("p13_strategy_revision_changed", 409)
		}
		if head["paused"] == true || head["active_id"] == nil {
			return nil, fail("p13_strategy_paused", 409)
		}
		current, e := s.version(ctx, tx, head["active_id"])
		if e != nil {
			return nil, e
		}
		prior := findStrategy(obj(current["configuration"]), strategyID)
		if prior == nil || prior["ordinaryBounds"] == nil || prior["mode"] == "human-led" {
			return nil, fail("p13_ordinary_boundary_requires_human", 409)
		}
		var id string
		var version int64
		var changes Object
		var newStrategyID any
		var sourceVersionID any
		if kind == "draft" || kind == "create-draft" {
			if head["draft_id"] != nil {
				return nil, fail("p13_existing_draft_requires_human", 409)
			}
			var configuration Object
			if kind == "create-draft" {
				if x["sourceVersionId"] != current["id"] {
					return nil, fail("p13_strategy_revision_changed", 409)
				}
				newStrategyID = uuid.NewString()
				sourceVersionID = x["sourceVersionId"]
				configuration, e = OrdinaryCreation(obj(current["configuration"]), x, str(newStrategyID))
			} else {
				configuration, e = OrdinaryChanges(obj(current["configuration"]), x)
			}
			if e != nil {
				return nil, e
			}
			id = uuid.NewString()
			if e = tx.QueryRow(ctx, `SELECT coalesce(max(version),0)+1 FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1`, s.Endpoint).Scan(&version); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO operations_p13_strategy_versions_v1(id,endpoint,version,configuration,created_by,created_at,parent_id,ordinary_strategy_id,ordinary_execution_id,ordinary_task_id,ordinary_ai_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, id, s.Endpoint, version, configuration, actor.ID, s.now(), current["id"], strategyID, executionID, taskID, accountID); e != nil {
				return nil, e
			}
			parameters := []any{}
			for _, v := range list(x["parameterEdits"]) {
				edit := obj(v)
				parameters = append(parameters, Object{"path": edit["path"], "before": leaf(prior["condition"], edit["path"])["value"], "after": edit["value"]})
			}
			changes = Object{"parameters": parameters}
			if enabled, ok := x["enabled"]; ok {
				changes["enabled"] = Object{"before": prior["enabled"], "after": enabled}
			}
			if mode, ok := x["mode"]; ok {
				changes["mode"] = Object{"before": prior["mode"], "after": mode}
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,draft_id=$2,updated_at=$3 WHERE endpoint=$1`, s.Endpoint, id, s.now()); e != nil {
				return nil, e
			}
		} else {
			candidate, e := s.version(ctx, tx, x["versionId"])
			if e != nil {
				return nil, e
			}
			if !ordinarySameIdentity(candidate, actor, taskID, accountID, executionID) || head["draft_id"] != candidate["id"] || candidate["ordinary_strategy_id"] != x["strategyId"] || candidate["parent_id"] != current["id"] || has(texts(head["blocked_version_ids"]), str(candidate["id"])) {
				return nil, fail("p13_ordinary_draft_changed", 409)
			}
			command, e := one(ctx, tx, `SELECT to_jsonb(c) FROM(SELECT operation_id,kind,input,result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operator_id=$2 AND kind IN ('ordinary-draft','ordinary-create-draft') AND result->>'versionId'=$3)c`, s.Endpoint, actor.ID, candidate["id"])
			if e != nil {
				return nil, e
			}
			if command == nil {
				return nil, fail("p13_ordinary_boundary_requires_human", 409)
			}
			var reconstructed Object
			if command["kind"] == "ordinary-create-draft" {
				created := obj(command["input"])
				newStrategyID = obj(command["result"])["newStrategyId"]
				sourceVersionID = created["sourceVersionId"]
				if created["sourceStrategyId"] != strategyID || created["sourceVersionId"] != current["id"] || !uuidPattern.MatchString(str(newStrategyID)) {
					return nil, fail("p13_ordinary_boundary_requires_human", 409)
				}
				if taskID != nil {
					metadata, err := s.domain().DutyAuthority().DutyMetadata(actor)
					if err != nil {
						return nil, err
					}
					var originalGrant *string
					err = tx.QueryRow(ctx, `SELECT grant_id::text FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2 AND actor_kind='operations-ai-service' AND action='strategies.ordinary.configure'`, s.Endpoint, command["operation_id"]).Scan(&originalGrant)
					if err != nil || originalGrant == nil || *originalGrant != str(obj(metadata["operation"])["grantId"]) {
						return nil, fail("p13_ordinary_boundary_requires_human", 409)
					}
				}
				reconstructed, e = OrdinaryCreation(obj(current["configuration"]), created, str(newStrategyID))
			} else {
				reconstructed, e = OrdinaryChanges(obj(current["configuration"]), obj(command["input"]))
			}
			if e != nil {
				return nil, e
			}
			if !same(reconstructed, candidate["configuration"]) {
				return nil, fail("p13_ordinary_boundary_requires_human", 409)
			}
			configuration, e := ParseConfiguration(obj(candidate["configuration"]))
			if e != nil {
				return nil, e
			}
			selectedID := strategyID
			if newStrategyID != nil {
				selectedID = str(newStrategyID)
			}
			selected := findStrategy(configuration, selectedID)
			samples := []any{}
			var preview Object
			if selected["enabled"] == true && selected["template"] != "selected-public-content-visibility" {
				preview, e = s.PreviewWithin(ctx, tx, configuration, str(selected["id"]), actor)
				if e != nil {
					return nil, e
				}
				if preview["valid"] != true || preview["sideEffects"] != false || num(preview["modelCalls"]) != 0 {
					return nil, fail("p13_rehearsal_required", 409)
				}
				samples = append(samples, list(preview["samples"])...)
			} else if selected["enabled"] == true {
				sampleVersion := current
				executionIDs := []string{}
				for depth := 0; sampleVersion != nil && depth < 200; depth++ {
					rehearsal, e := one(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT execution_ids FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND version_id=$2 AND (result->>'valid')::boolean ORDER BY created_at DESC LIMIT 1)r`, s.Endpoint, sampleVersion["id"])
					if e != nil {
						return nil, e
					}
					if len(list(rehearsal["execution_ids"])) > 0 {
						executionIDs = texts(rehearsal["execution_ids"])
						break
					}
					if sampleVersion["ordinary_execution_id"] == nil && sampleVersion["ordinary_task_id"] == nil {
						break
					}
					sampleVersion, e = s.version(ctx, tx, sampleVersion["parent_id"])
					if e != nil {
						return nil, e
					}
				}
				if s.Effects == nil && len(executionIDs) > 0 {
					return nil, fail("p13_effects_not_configured", 503)
				}
				for _, executionID := range executionIDs {
					facts, e := s.Effects.InspectWithin(ctx, tx, executionID, "", []Object{selected})
					if e != nil {
						if fault.Code(e) == "internal_error" {
							return nil, e
						}
						continue
					}
					if facts["domain"] != selected["domain"] {
						continue
					}
					classification := Classify(configuration, selected, conditionFacts(facts, selected["id"]))
					if classification["route"] != "blocked" {
						samples = append(samples, Object{"strategyId": selected["id"], "executionId": executionID, "facts": facts, "classification": classification})
					}
				}
				if len(samples) == 0 {
					return nil, fail("p13_rehearsal_required", 409)
				}
			}
			id, version = str(candidate["id"]), num(candidate["version"])
			rehearsalID := uuid.NewString()
			classification := "stop-new-matters"
			if selected["enabled"] == true {
				classification = "bounded-ordinary-consumer"
			}
			result := Object{"valid": true, "sideEffects": false, "modelCalls": 0, "classification": classification, "samples": samples, "uncoveredStrategyIds": []any{}}
			if preview != nil {
				result["preview"] = preview
			}
			ids := []string{}
			for _, v := range samples {
				if str(obj(v)["executionId"]) != "" {
					ids = append(ids, str(obj(v)["executionId"]))
				}
			}
			if _, e = tx.Exec(ctx, `INSERT INTO operations_p13_strategy_rehearsals_v1(id,endpoint,version_id,operator_id,execution_ids,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, rehearsalID, s.Endpoint, id, actor.ID, ids, result, s.now()); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,active_id=$2,draft_id=NULL,updated_at=$3 WHERE endpoint=$1`, s.Endpoint, id, s.now()); e != nil {
				return nil, e
			}
			changes = Object{"rehearsalId": rehearsalID, "parentVersionId": current["id"]}
		}
		if _, e = s.ordinaryActor(ctx, tx, a, strategyID, action, x); e != nil {
			return nil, e
		}
		eventKind := "publish"
		if kind == "draft" || kind == "create-draft" {
			eventKind = "ordinary-draft"
		}
		actorKind := "business-operator"
		if taskID != nil {
			actorKind = "operations-ai-service"
		} else if executionID != nil {
			actorKind = "operations-executor"
		}
		if e = s.event(ctx, tx, eventKind, Object{"versionId": id, "strategyId": strategyID, "operatorId": actor.ID, "operationId": x["operationId"], "metadata": Object{"version": version, "scope": "ordinary-strategy", "actorKind": actorKind, "aiAccountId": accountID, "taskId": taskID, "newStrategyId": newStrategyID, "changes": changes}}); e != nil {
			return nil, e
		}
		if e = s.domain().Record(ctx, tx, actor, action, Object{"versionId": id, "strategyId": strategyID, "revision": head["revision"]}, Object{"version": version, "revision": num(head["revision"]) + 1}, x["operationId"]); e != nil {
			return nil, e
		}
		state := "active-for-new-matters"
		if kind == "draft" || kind == "create-draft" {
			state = "saved"
		}
		result := Object{"operationId": x["operationId"], "strategyId": strategyID, "versionId": id, "version": version, "revision": num(head["revision"]) + 1, "state": state, "newMattersOnly": true}
		if newStrategyID != nil {
			result["sourceStrategyId"], result["sourceVersionId"], result["newStrategyId"] = strategyID, sourceVersionID, newStrategyID
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_p13_strategy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, s.Endpoint, x["operationId"], actor.ID, "ordinary-"+kind, x, result, s.now()); e != nil {
			return nil, e
		}
		result["replayed"] = false
		return result, nil
	})
}
