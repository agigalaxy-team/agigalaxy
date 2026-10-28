package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func conditionFacts(facts Object, id any) Object {
	x := clone(obj(facts["facts"]))
	x["conditionState"] = obj(obj(facts["conditionResults"])[str(id)])["state"]
	return x
}
func (s *Service) Rehearsal(ctx context.Context, a Actor, input Object) (Object, error) {
	x, e := ParseCommand("rehearsal", input)
	if e != nil {
		return nil, e
	}
	actor, e := s.current(ctx, a, "strategies.read")
	if e != nil {
		return nil, e
	}
	version, e := s.version(ctx, s.Pool, x["versionId"])
	if e != nil {
		return nil, e
	}
	if version == nil {
		return nil, fail("p13_version_not_found", 404)
	}
	configuration, e := ParseConfiguration(obj(version["configuration"]))
	if e != nil {
		return nil, e
	}
	strategies := []Object{}
	for _, v := range list(configuration["strategies"]) {
		strategies = append(strategies, obj(v))
	}
	samples := []any{}
	for _, executionID := range texts(x["executionIds"]) {
		if s.Effects == nil {
			return nil, fail("p13_effects_not_configured", 503)
		}
		facts, e := s.Effects.Inspect(ctx, executionID, actor.ID, strategies)
		if e != nil {
			return nil, e
		}
		for _, strategy := range strategies {
			if strategy["domain"] == facts["domain"] && strategy["enabled"] == true && strategy["template"] == "selected-public-content-visibility" {
				samples = append(samples, Object{"strategyId": strategy["id"], "executionId": executionID, "facts": facts, "classification": Classify(configuration, strategy, conditionFacts(facts, strategy["id"]))})
			}
		}
	}
	previews, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) ([]any, error) {
		out := []any{}
		for _, strategy := range strategies {
			if strategy["enabled"] == true && strategy["execution"] != nil {
				p, e := s.PreviewWithin(ctx, tx, configuration, str(strategy["id"]), actor)
				if e != nil {
					return nil, e
				}
				p["strategyId"] = strategy["id"]
				out = append(out, p)
			}
		}
		return out, nil
	})
	if e != nil {
		return nil, e
	}
	uncovered := []any{}
	add := func(id any) {
		for _, old := range uncovered {
			if old == id {
				return
			}
		}
		uncovered = append(uncovered, id)
	}
	for _, strategy := range strategies {
		if strategy["enabled"] != true || strategy["template"] != "selected-public-content-visibility" || strategy["execution"] != nil {
			continue
		}
		covered := false
		for _, v := range samples {
			r := obj(v)
			covered = covered || r["strategyId"] == strategy["id"] && obj(r["classification"])["route"] != "blocked"
		}
		if !covered {
			add(strategy["id"])
		}
	}
	for _, v := range previews {
		if obj(v)["valid"] != true {
			add(obj(v)["strategyId"])
		}
	}
	result := Object{"versionId": version["id"], "classification": "program-consumer-qualification", "sideEffects": false, "modelCalls": 0, "samples": samples, "executionPreviews": previews, "uncoveredStrategyIds": uncovered, "valid": len(uncovered) == 0}
	if _, e = s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.lock(ctx, tx, "rehearsal:"+str(x["operationId"])); e != nil {
			return nil, e
		}
		old, e := one(ctx, tx, `SELECT to_jsonb(r) FROM operations_p13_strategy_rehearsals_v1 r WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if old["operator_id"] != actor.ID || old["version_id"] != version["id"] || !same(old["execution_ids"], x["executionIds"]) {
				return nil, fail("p13_operation_conflict", 409)
			}
			out := clone(obj(old["result"]))
			out["rehearsalId"], out["replayed"] = old["id"], true
			return s.metadata(out), nil
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_p13_strategy_rehearsals_v1(id,endpoint,version_id,operator_id,execution_ids,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, x["operationId"], s.Endpoint, version["id"], actor.ID, texts(x["executionIds"]), result, s.now()); e != nil {
			return nil, e
		}
		out := clone(result)
		out["rehearsalId"], out["replayed"] = x["operationId"], false
		return s.metadata(out), nil
	})
}
func (s *Service) Publish(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseCommand("publish", input)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, a, "publish", x, authorize, func(tx pgx.Tx, actor Actor, head Object) (Object, error) {
		version, e := s.version(ctx, tx, x["versionId"])
		if e != nil {
			return nil, e
		}
		sample, e := one(ctx, tx, `SELECT to_jsonb(r) FROM operations_p13_strategy_rehearsals_v1 r WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["rehearsalId"])
		if e != nil {
			return nil, e
		}
		if version == nil || head["draft_id"] != version["id"] || has(texts(head["blocked_version_ids"]), str(version["id"])) {
			return nil, fail("p13_strategy_draft_changed", 409)
		}
		if sample == nil || sample["version_id"] != version["id"] || sample["operator_id"] != actor.ID || obj(sample["result"])["valid"] != true {
			return nil, fail("p13_rehearsal_required", 409)
		}
		configuration, e := ParseConfiguration(obj(version["configuration"]))
		if e != nil {
			return nil, e
		}
		for _, v := range list(obj(sample["result"])["samples"]) {
			prior := obj(v)
			strategy := findStrategy(configuration, prior["strategyId"])
			if s.Effects == nil {
				return nil, fail("p13_effects_not_configured", 503)
			}
			conditions := []Object{}
			if strategy != nil {
				conditions = append(conditions, strategy)
			}
			current, e := s.Effects.InspectWithin(ctx, tx, str(prior["executionId"]), actor.ID, conditions)
			if e != nil {
				return nil, e
			}
			if strategy == nil || Classify(configuration, strategy, conditionFacts(current, strategy["id"]))["route"] == "blocked" || !same(current["sourceVersion"], obj(prior["facts"])["sourceVersion"]) || !same(current["decisionRevision"], obj(prior["facts"])["decisionRevision"]) {
				return nil, fail("p13_rehearsal_changed", 409)
			}
		}
		for _, v := range list(configuration["strategies"]) {
			strategy := obj(v)
			if strategy["enabled"] != true {
				continue
			}
			if strategy["execution"] != nil {
				var prior Object
				for _, v := range list(obj(sample["result"])["executionPreviews"]) {
					if obj(v)["strategyId"] == strategy["id"] {
						prior = obj(v)
						break
					}
				}
				current, e := s.PreviewWithin(ctx, tx, configuration, str(strategy["id"]), actor)
				if e != nil {
					return nil, e
				}
				current["strategyId"] = strategy["id"]
				if prior == nil || prior["valid"] != true || current["valid"] != true || !same(prior, current) {
					return nil, fail("p13_rehearsal_changed", 409)
				}
			}
			if strategy["template"] == "selected-public-content-visibility" || strategy["execution"] != nil {
				var objective any
				for _, v := range list(configuration["domains"]) {
					if obj(v)["key"] == strategy["domain"] {
						objective = obj(v)["objective"]
					}
				}
				if strategy["objective"] == nil || obj(configuration["common"])["objective"] == nil || objective == nil {
					return nil, fail("p13_goal_required", 409)
				}
			}
			if id := obj(strategy["recovery"])["versionId"]; id != nil {
				prior, e := s.version(ctx, tx, id)
				if e != nil {
					return nil, e
				}
				if prior == nil || prior["id"] == version["id"] || has(texts(head["blocked_version_ids"]), str(prior["id"])) || findStrategy(obj(prior["configuration"]), strategy["id"])["enabled"] != true {
					return nil, fail("p13_recovery_target_unavailable", 409)
				}
			}
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,active_id=$2,draft_id=NULL,paused=false,updated_at=$3 WHERE endpoint=$1`, s.Endpoint, version["id"], s.now()); e != nil {
			return nil, e
		}
		if e = s.event(ctx, tx, "publish", Object{"versionId": version["id"], "operatorId": actor.ID, "operationId": x["operationId"], "metadata": Object{"version": version["version"], "rehearsalId": x["rehearsalId"]}}); e != nil {
			return nil, e
		}
		return Object{"operationId": x["operationId"], "versionId": version["id"], "version": version["version"], "revision": num(head["revision"]) + 1, "state": "active-for-new-matters"}, nil
	})
}
