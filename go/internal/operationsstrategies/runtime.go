package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ownedRun(ctx context.Context, a Actor, id, action string) (Actor, Object, error) {
	actor, e := s.current(ctx, a, action)
	if e != nil {
		return Actor{}, nil, e
	}
	if !uuidPattern.MatchString(id) {
		return Actor{}, nil, invalid()
	}
	row, e := s.runRow(ctx, s.Pool, id)
	if e != nil {
		return Actor{}, nil, e
	}
	if row == nil || row["operator_id"] != actor.ID {
		return Actor{}, nil, fail("p13_run_not_found", 404)
	}
	return actor, row, nil
}
func (s *Service) nativeRead(ctx context.Context, row Object, history bool) (Object, error) {
	if s.Native == nil {
		return nil, nil
	}
	return s.Native.Read(ctx, row, history)
}
func nativeSummary(x Object) any {
	if x == nil {
		return nil
	}
	out := Object{"runId": x["runId"], "status": x["status"], "awaitingHuman": x["awaitingHuman"] == true, "pauseKind": x["pauseKind"], "pauseId": x["pauseId"], "steps": x["steps"], "currentStep": x["currentStep"], "workflowId": x["workflowId"], "workflowVersion": x["workflowVersion"]}
	if out["steps"] == nil {
		out["steps"] = []any{}
	}
	return out
}
func (s *Service) RunDetail(ctx context.Context, a Actor, id string) (Object, error) {
	_, row, e := s.ownedRun(ctx, a, id, "strategies.read")
	if e != nil {
		return nil, e
	}
	native, e := s.nativeRead(ctx, row, true)
	if e != nil {
		return nil, e
	}
	version, e := s.version(ctx, s.Pool, row["version_id"])
	if e != nil {
		return nil, e
	}
	strategy := findStrategy(obj(version["configuration"]), row["strategy_id"])
	continuation := s.continuationCapability(ctx, a, row, native)
	current, e := s.current(ctx, a, "strategies.read")
	if e != nil {
		return nil, e
	}
	if continuation["canContinue"] == true && !has(current.Permissions, "strategies.run") {
		continuation = Object{"canContinue": false, "continueCode": "permission-denied"}
	}
	var strategyView, versionView any
	if strategy != nil {
		strategyView = Object{"id": strategy["id"], "name": strategy["name"], "domain": strategy["domain"], "mode": strategy["mode"], "judgment": strategy["judgment"]}
	}
	if version != nil {
		versionView = Object{"id": version["id"], "version": version["version"]}
	}
	run := Object{"id": row["id"], "strategyId": row["strategy_id"], "versionId": row["version_id"], "executionId": row["execution_id"], "strategy": strategyView, "version": versionView, "target": Object{"kind": row["target_kind"], "id": row["target_id"], "sourceVersion": row["source_version"], "decisionRevision": row["decision_revision"]}, "decision": row["decision"], "workflow": Object{"id": row["workflow_id"], "version": row["workflow_version"]}, "ruleRefs": row["rule_refs"], "route": row["route"], "state": row["state"], "code": row["code"], "native": nativeSummary(native), "canReadNativeRun": has(current.Permissions, "audit.read"), "effect": row["effect_result"], "createdAt": iso(row["created_at"]), "updatedAt": iso(row["updated_at"])}
	for k, v := range continuation {
		run[k] = v
	}
	return s.metadata(Object{"run": run}), nil
}
func (s *Service) continuationCapability(ctx context.Context, a Actor, row, native Object) Object {
	no := func(code string) Object { return Object{"canContinue": false, "continueCode": code} }
	if row["effect_result"] != nil || has([]string{"completed", "no-action", "blocked"}, str(row["state"])) {
		return no("not-waiting")
	}
	if native == nil {
		return no("runtime-unavailable")
	}
	if native["status"] != "PAUSED" || native["awaitingHuman"] != true {
		return no("not-waiting")
	}
	if native["runId"] != row["native_run_id"] || native["workflowId"] != row["workflow_id"] || !same(native["workflowVersion"], row["workflow_version"]) || !pauseID.MatchString(str(native["pauseId"])) {
		return no("check-unavailable")
	}
	_, e := s.current(ctx, a, "strategies.run")
	if e == nil {
		head, err := s.head(ctx, s.Pool)
		e = err
		if e == nil {
			live, err := s.version(ctx, s.Pool, head["active_id"])
			e = err
			if e == nil {
				enabled := false
				for _, v := range list(obj(live["configuration"])["domains"]) {
					enabled = enabled || obj(v)["key"] == "governance" && obj(v)["executionEnabled"] == true
				}
				if live == nil || head["paused"] == true || has(texts(head["blocked_version_ids"]), str(row["version_id"])) || obj(obj(live["configuration"])["common"])["automationEnabled"] != true || !enabled {
					return no("strategy-paused")
				}
			}
		}
		if e == nil {
			commands, err := many(ctx, s.Pool, `SELECT to_jsonb(c) FROM(SELECT result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND kind='continue' AND input->>'runId'=$2)c`, s.Endpoint, row["id"])
			e = err
			if e == nil {
				for _, v := range commands {
					binding := obj(obj(v["result"])["continuation"])
					if binding == nil || binding["nativeRunId"] == native["runId"] && binding["pauseId"] == native["pauseId"] {
						return no("decision-recorded")
					}
				}
			}
		}
		if e == nil {
			if s.Effects == nil {
				return no("check-unavailable")
			}
			current, err := s.Effects.Inspect(ctx, str(row["execution_id"]), str(row["operator_id"]), nil)
			e = err
			if e == nil {
				qualified := same(current["sourceVersion"], row["source_version"]) && same(current["decisionRevision"], row["decision_revision"])
				for _, v := range obj(current["facts"]) {
					qualified = qualified && v == true
				}
				if !qualified {
					return no("qualification-changed")
				}
				return Object{"canContinue": true, "continueCode": nil}
			}
		}
	}
	switch fault.Code(e) {
	case "operations_permission_denied", "business_admin_denied":
		return no("permission-denied")
	case "operations_agentos_execution_inactive", "operations_agentos_authority_changed", "operations_agentos_scope_unresolved", "operations_agentos_scope_denied", "operations_agentos_action_unavailable", "operations_ai_work_disabled", "operations_ai_work_unassigned", "operations_agentos_ai_use_denied", "p13_execution_not_found":
		return no("authorization-changed")
	case "operations_agentos_source_changed", "p13_current_qualification_changed", "operations_agentos_prepared_command_required":
		return no("qualification-changed")
	}
	return no("check-unavailable")
}
func (s *Service) Run(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseCommand("run", input)
	if e != nil {
		return nil, e
	}
	if authorize == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	actor, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "strategies.run", authorize) })
	if e != nil {
		return nil, e
	}
	existing, e := s.runRow(ctx, s.Pool, str(x["operationId"]))
	if e != nil {
		return nil, e
	}
	if existing != nil {
		if existing["operator_id"] != actor.ID || existing["strategy_id"] != x["strategyId"] || existing["execution_id"] != x["executionId"] {
			return nil, fail("p13_operation_conflict", 409)
		}
		if existing["state"] == "prepared" && has([]string{"model-not-configured", "native-not-connected"}, str(existing["code"])) && s.Native != nil {
			recorded, e := s.nativeRead(ctx, existing, false)
			if e != nil {
				return nil, e
			}
			if recorded["status"] == "NOT_RECORDED" {
				if _, e = s.NativeContext(ctx, Object{"runId": existing["id"], "executionId": existing["execution_id"], "operation": "run"}); e != nil {
					return nil, e
				}
				if s.Effects == nil {
					return nil, fail("p13_effects_not_configured", 503)
				}
				if _, e = s.Effects.Inspect(ctx, str(existing["execution_id"]), actor.ID, nil); e != nil {
					return nil, e
				}
				if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "strategies.run", authorize) }); e != nil {
					return nil, e
				}
				if _, e = s.Native.Start(ctx, existing); e != nil {
					return nil, e
				}
				if _, e = s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET code=NULL,updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, existing["id"], s.now()); e != nil {
					return nil, e
				}
			}
		}
		return s.RunDetail(ctx, a, str(existing["id"]))
	}
	plannedHead, e := s.head(ctx, s.Pool)
	if e != nil {
		return nil, e
	}
	plannedVersion, e := s.version(ctx, s.Pool, plannedHead["active_id"])
	if e != nil {
		return nil, e
	}
	plannedStrategy := findStrategy(obj(plannedVersion["configuration"]), x["strategyId"])
	if plannedStrategy == nil {
		return nil, fail("p13_strategy_not_found", 404)
	}
	if s.Effects == nil {
		return nil, fail("p13_effects_not_configured", 503)
	}
	facts, e := s.Effects.Inspect(ctx, str(x["executionId"]), actor.ID, []Object{plannedStrategy})
	if e != nil {
		return nil, e
	}
	binding, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.lock(ctx, tx, ""); e != nil {
			return nil, e
		}
		if e := s.lock(ctx, tx, "execution:"+str(x["executionId"])); e != nil {
			return nil, e
		}
		if _, e := s.actor(ctx, tx, a, "strategies.run", authorize); e != nil {
			return nil, e
		}
		head, e := s.head(ctx, tx)
		if e != nil {
			return nil, e
		}
		version, e := s.version(ctx, tx, head["active_id"])
		if e != nil {
			return nil, e
		}
		if head["paused"] == true || version == nil || has(texts(head["blocked_version_ids"]), str(version["id"])) {
			return nil, fail("p13_strategy_paused", 409)
		}
		if version["id"] != plannedVersion["id"] {
			return nil, fail("p13_strategy_revision_changed", 409)
		}
		configuration, e := ParseConfiguration(obj(version["configuration"]))
		if e != nil {
			return nil, e
		}
		strategy := findStrategy(configuration, x["strategyId"])
		if strategy == nil {
			return nil, fail("p13_strategy_not_found", 404)
		}
		classified := Classify(configuration, strategy, conditionFacts(facts, strategy["id"]))
		if classified["route"] == "blocked" {
			return nil, fail("p13_qualification_required", 409)
		}
		old, e := one(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT id FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND execution_id=$2)r`, s.Endpoint, x["executionId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			return nil, fail("p13_execution_already_bound", 409)
		}
		rules, e := many(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT policy_key,version FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key='business-controls' ORDER BY version DESC LIMIT 1)r`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		refs := []any{}
		for _, r := range rules {
			refs = append(refs, Object{"key": r["policy_key"], "publishedVersion": r["version"], "scope": "new-writes-only", "appliesToPreparedVisibility": false})
		}
		saved, e := one(ctx, tx, `INSERT INTO operations_p13_strategy_runs_v1(id,endpoint,version_id,strategy_id,execution_id,operator_id,workflow_id,workflow_version,session_id,target_kind,target_id,source_version,decision_revision,rule_refs,route,state,decision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,'prepared',$15,$16,$16) RETURNING to_jsonb(operations_p13_strategy_runs_v1)`, x["operationId"], s.Endpoint, version["id"], strategy["id"], x["executionId"], actor.ID, WorkflowID, uuid.NewString(), obj(facts["target"])["kind"], obj(facts["target"])["id"], facts["sourceVersion"], facts["decisionRevision"], refs, classified["route"], classified["decision"], s.now())
		if e != nil {
			return nil, e
		}
		if e = s.event(ctx, tx, "matter-pinned", Object{"versionId": version["id"], "strategyId": strategy["id"], "runId": saved["id"], "operatorId": actor.ID, "operationId": x["operationId"], "metadata": Object{"route": classified["route"], "workflowVersion": 1}}); e != nil {
			return nil, e
		}
		return saved, nil
	})
	if e != nil {
		return nil, e
	}
	if s.Native == nil {
		e = fail("p13_native_workflow_not_connected", 503)
	} else {
		_, e = s.Native.Start(ctx, binding)
	}
	if e == nil {
		return s.RunDetail(ctx, a, str(binding["id"]))
	}
	state, code := "unknown", "native-dispatch-unknown"
	switch fault.Code(e) {
	case "operations_agentos_model_not_configured":
		state, code = "prepared", "model-not-configured"
	case "p13_native_workflow_not_connected":
		state, code = "prepared", "native-not-connected"
	}
	_, updateError := s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET state=$3,code=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2`, s.Endpoint, binding["id"], state, code, s.now())
	if updateError != nil {
		return nil, updateError
	}
	return nil, e
}
