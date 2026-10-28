package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Step(ctx context.Context, input Object) (Object, error) {
	binding, e := s.nativeBinding(ctx, input)
	if e != nil {
		return nil, e
	}
	x, row, configuration, strategy := binding.x, binding.row, binding.configuration, binding.strategy
	if x["phase"] == "failed" {
		failure := str(x["failure"])
		if failure == "" {
			failure = "workflow-failed"
		}
		return s.stopBadVersion(ctx, row, strategy, failure)
	}
	if row["effect_result"] != nil {
		return Object{"state": "completed", "effect": row["effect_result"]}, nil
	}
	if row["decision"] == "no-action" && has([]string{"effect", "finished"}, str(x["phase"])) {
		if _, e = s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET state='no-action',updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], s.now()); e != nil {
			return nil, e
		}
		return Object{"state": "no-action"}, nil
	}
	if s.Effects == nil {
		return nil, fail("p13_effects_not_configured", 503)
	}
	var priorEffect Object
	if x["phase"] == "effect" {
		priorEffect, e = s.Effects.PriorEffect(ctx, row)
		if e != nil {
			return nil, e
		}
	}
	if priorEffect == nil {
		facts, e := s.Effects.Inspect(ctx, str(row["execution_id"]), str(row["operator_id"]), []Object{strategy})
		if e != nil {
			return nil, e
		}
		classified := Classify(configuration, strategy, conditionFacts(facts, strategy["id"]))
		if !same(facts["sourceVersion"], row["source_version"]) || !same(facts["decisionRevision"], row["decision_revision"]) || classified["route"] == "blocked" {
			if _, e = s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET state='blocked',code='current-qualification-changed',updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], s.now()); e != nil {
				return nil, e
			}
			return nil, fail("p13_current_qualification_changed", 409)
		}
	}
	if _, e = s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET native_run_id=$3,updated_at=$4,state=CASE WHEN $5 AND state NOT IN ('completed','no-action','blocked') AND effect_result IS NULL THEN CASE WHEN (route='human' OR decision IN ('human-required','needs-input')) AND NOT (approved_by IS NOT NULL AND approval_native_run_id=$3) THEN 'awaiting-human' ELSE 'running' END ELSE state END WHERE endpoint=$1 AND id=$2 AND (native_run_id IS NULL OR native_run_id=$3)`, s.Endpoint, row["id"], x["nativeRunId"], s.now(), x["phase"] == "prepare"); e != nil {
		return nil, e
	}
	switch x["phase"] {
	case "prepare":
		return Object{"runId": row["id"], "strategyId": strategy["id"], "versionId": row["version_id"], "workflow": Object{"id": WorkflowID, "version": 1}, "route": row["route"], "mode": strategy["mode"], "judgment": strategy["judgment"], "instructions": strategy["instructions"], "requiresHuman": row["route"] == "human" || row["decision"] == "human-required", "requiresInput": row["decision"] == "needs-input", "decision": row["decision"], "domain": strategy["domain"], "sourceRef": Object{"kind": row["target_kind"], "id": row["target_id"], "version": row["source_version"]}}, nil
	case "decision":
		if !has([]string{"ai", "human"}, str(row["route"])) || x["decision"] == nil {
			return nil, fail("p13_decision_denied", 403)
		}
		decision := x["decision"]
		if row["route"] == "human" || x["decision"] == "needs-input" && strategy["mode"] != "ai-human-participation" {
			decision = "human-required"
		}
		state := "running"
		if decision == "no-action" {
			state = "no-action"
		} else if has([]string{"human-required", "needs-input"}, str(decision)) {
			state = "awaiting-human"
		}
		if _, e = s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET decision=$3,state=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], decision, state, s.now()); e != nil {
			return nil, e
		}
		var advisory any
		if row["route"] == "human" {
			advisory = x["decision"]
		}
		return Object{"decision": decision, "advisory": advisory, "requiresHuman": decision == "human-required", "requiresInput": decision == "needs-input"}, nil
	case "finished":
		if row["decision"] == "no-action" {
			if _, e = s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET state='no-action',updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], s.now()); e != nil {
				return nil, e
			}
			return Object{"state": "no-action"}, nil
		}
		return nil, fail("p13_effect_receipt_required", 409)
	}
	if row["route"] == "ai" && !has([]string{"proceed", "human-required"}, str(row["decision"])) {
		return nil, fail("p13_decision_required", 409)
	}
	if row["route"] == "human" || row["decision"] == "human-required" {
		if row["approved_by"] == nil || row["approval_native_run_id"] != x["nativeRunId"] {
			return nil, fail("p13_human_confirmation_required", 409)
		}
		if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
			return true, s.storedHuman(ctx, tx, str(row["approved_by"]), "strategies.run")
		}); e != nil {
			return nil, e
		}
	}
	effect, e := s.Effects.Execute(ctx, row)
	if e == nil {
		result := Object{"operationId": effect["operationId"], "kind": effect["kind"], "id": effect["id"], "visibility": effect["visibility"]}
		if _, e = s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET state='completed',effect_result=$3,code=NULL,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], result, s.now()); e == nil {
			e = s.event(ctx, s.Pool, "effect-recorded", Object{"versionId": row["version_id"], "strategyId": row["strategy_id"], "runId": row["id"], "metadata": Object{"operationId": result["operationId"]}})
		}
		if e == nil {
			return Object{"state": "completed", "effect": result}, nil
		}
	}
	if _, updateError := s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET state='unknown',code='original-effect-reconciliation-required',updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], s.now()); updateError != nil {
		return nil, updateError
	}
	return nil, e
}
func (s *Service) stopBadVersion(ctx context.Context, row, strategy Object, failure string) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.lock(ctx, tx, ""); e != nil {
			return nil, e
		}
		head, e := s.head(ctx, tx)
		if e != nil {
			return nil, e
		}
		blocked := texts(head["blocked_version_ids"])
		if !has(blocked, str(row["version_id"])) {
			blocked = append(blocked, str(row["version_id"]))
		}
		active, paused, recovered := head["active_id"], head["paused"], false
		if active == row["version_id"] {
			paused = true
			recovery := obj(strategy["recovery"])
			if recovery["versionId"] != nil && has(texts(recovery["conditions"]), failure) && !has(blocked, str(recovery["versionId"])) {
				prior, e := s.version(ctx, tx, recovery["versionId"])
				if e != nil {
					return nil, e
				}
				published, e := one(ctx, tx, `SELECT to_jsonb(e) FROM(SELECT 1 AS present FROM operations_p13_strategy_events_v1 WHERE endpoint=$1 AND version_id=$2 AND kind='publish' LIMIT 1)e`, s.Endpoint, recovery["versionId"])
				if e != nil {
					return nil, e
				}
				var target Object
				if prior != nil {
					target, e = ParseConfiguration(obj(prior["configuration"]))
					if e != nil {
						return nil, e
					}
				}
				domainEnabled := false
				for _, v := range list(target["domains"]) {
					domainEnabled = domainEnabled || obj(v)["key"] == strategy["domain"] && obj(v)["executionEnabled"] == true
				}
				if published != nil && obj(target["common"])["automationEnabled"] == true && domainEnabled && findStrategy(target, strategy["id"])["enabled"] == true {
					approvedVersion, e := s.version(ctx, tx, row["version_id"])
					if e != nil {
						return nil, e
					}
					for depth := 0; approvedVersion != nil && (approvedVersion["ordinary_execution_id"] != nil || approvedVersion["ordinary_task_id"] != nil) && depth < 200; depth++ {
						parent, e := s.version(ctx, tx, approvedVersion["parent_id"])
						if e != nil {
							return nil, e
						}
						parentStrategy := findStrategy(obj(parent["configuration"]), strategy["id"])
						if parentStrategy == nil || !same(parentStrategy["recovery"], strategy["recovery"]) {
							approvedVersion = nil
							break
						}
						approvedVersion = parent
					}
					var approval Object
					if approvedVersion != nil && approvedVersion["ordinary_execution_id"] == nil && approvedVersion["ordinary_task_id"] == nil {
						approval, e = one(ctx, tx, `SELECT to_jsonb(e) FROM(SELECT operator_id FROM operations_p13_strategy_events_v1 WHERE endpoint=$1 AND version_id=$2 AND kind='publish' AND metadata->>'scope' IS DISTINCT FROM 'ordinary-strategy' ORDER BY sequence DESC LIMIT 1)e`, s.Endpoint, approvedVersion["id"])
						if e != nil {
							return nil, e
						}
					}
					if approval["operator_id"] != nil {
						if e = s.storedHuman(ctx, tx, str(approval["operator_id"]), "strategies.publish"); e == nil {
							active, paused, recovered = prior["id"], false, true
						}
					}
				}
			}
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,active_id=$2,paused=$3,blocked_version_ids=$4,updated_at=$5 WHERE endpoint=$1`, s.Endpoint, active, paused, blocked, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET state='blocked',code=$3,updated_at=$4 WHERE endpoint=$1 AND version_id=$2 AND state NOT IN ('completed','no-action')`, s.Endpoint, row["version_id"], failure, s.now()); e != nil {
			return nil, e
		}
		var recoveredID any
		if recovered {
			recoveredID = active
		}
		if e = s.event(ctx, tx, "automatic-stop", Object{"versionId": row["version_id"], "strategyId": row["strategy_id"], "runId": row["id"], "metadata": Object{"failure": failure, "recovered": recovered, "recoveredVersionId": recoveredID, "newMattersOnly": true}}); e != nil {
			return nil, e
		}
		return Object{"state": "blocked", "failure": failure, "recovered": recovered, "recoveredVersionId": recoveredID, "newMattersOnly": true}, nil
	})
}
