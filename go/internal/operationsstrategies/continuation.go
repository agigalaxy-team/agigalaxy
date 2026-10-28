package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) continuationReceipt(ctx context.Context, row, command Object, history bool) (Object, error) {
	binding := obj(obj(command["result"])["continuation"])
	operationID := command["operation_id"]
	if operationID == nil {
		operationID = obj(command["result"])["operationId"]
	}
	base := Object{"operationId": operationID, "runId": row["id"], "nativeRunId": binding["nativeRunId"], "pauseId": binding["pauseId"]}
	unknown := func() (Object, error) { base["state"] = "unknown"; return base, nil }
	if binding == nil || s.Native == nil {
		return unknown()
	}
	pause := str(base["pauseId"])
	value, e := s.Native.Continuation(ctx, row, str(operationID), history, &pause)
	if e != nil {
		return nil, e
	}
	if value == nil {
		return unknown()
	}
	for k, v := range base {
		if !same(value[k], v) {
			return unknown()
		}
	}
	state := "unknown"
	if has([]string{"accepted", "not-recorded"}, str(value["state"])) {
		state = str(value["state"])
	}
	if state == "accepted" {
		if e = s.settleContinuation(ctx, row, command, base); e != nil {
			return nil, e
		}
	}
	base["state"] = state
	return base, nil
}
func (s *Service) settleContinuation(ctx context.Context, row, command, binding Object) error {
	result := obj(command["result"])
	approved := result["confirmed"] == true || result["inputDecision"] == "proceed"
	declined := result["confirmed"] == false || result["inputDecision"] == "no-action"
	if (!approved && !declined) || row["native_run_id"] != binding["nativeRunId"] {
		return nil
	}
	state := "running"
	if declined {
		state = "no-action"
	}
	_, e := s.Pool.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET state=$5,decision=CASE WHEN $6 THEN 'no-action' ELSE decision END,updated_at=$7 WHERE endpoint=$1 AND id=$2 AND operator_id=$3 AND native_run_id=$4 AND effect_result IS NULL AND state NOT IN ('completed','no-action','blocked') AND code IS DISTINCT FROM 'original-effect-reconciliation-required' AND (state IS DISTINCT FROM $5 OR ($6 AND decision IS DISTINCT FROM 'no-action')) AND (($6 AND approved_by IS NULL AND approval_native_run_id IS NULL) OR (NOT $6 AND approved_by=$3 AND approval_native_run_id=$4))`, s.Endpoint, row["id"], row["operator_id"], binding["nativeRunId"], state, declined, s.now())
	return e
}
func (s *Service) Continue(ctx context.Context, a Actor, id string, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseCommand("continue", input)
	if e != nil {
		return nil, e
	}
	actor, row, e := s.ownedRun(ctx, a, id, "strategies.run")
	if e != nil {
		return nil, e
	}
	if authorize == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "strategies.run", authorize) }); e != nil {
		return nil, e
	}
	expectedInput := clone(x)
	expectedInput["runId"] = id
	sameCommand := func(old Object) error {
		if old["operator_id"] != actor.ID || old["kind"] != "continue" || !same(old["input"], expectedInput) {
			return fail("p13_operation_conflict", 409)
		}
		return nil
	}
	command, e := one(ctx, s.Pool, `SELECT to_jsonb(c) FROM operations_p13_strategy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, x["operationId"])
	if e != nil {
		return nil, e
	}
	if command != nil {
		if e = sameCommand(command); e != nil {
			return nil, e
		}
	} else {
		native, e := s.nativeRead(ctx, row, false)
		if e != nil {
			return nil, e
		}
		if native["awaitingHuman"] != true || native["runId"] != row["native_run_id"] {
			return nil, fail("p13_run_not_paused", 409)
		}
		if !pauseID.MatchString(str(native["pauseId"])) {
			return nil, fail("p13_native_continuation_not_ready", 503)
		}
		_, inputDecision := x["inputDecision"]
		_, confirmed := x["confirmed"]
		if native["pauseKind"] == "input" && !inputDecision || native["pauseKind"] != "input" && !confirmed {
			return nil, fail("p13_pause_input_mismatch", 400)
		}
		command, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			if e := s.lock(ctx, tx, "run:"+id); e != nil {
				return nil, e
			}
			if e := s.lock(ctx, tx, "operation:"+str(x["operationId"])); e != nil {
				return nil, e
			}
			if _, e := s.actor(ctx, tx, a, "strategies.run", authorize); e != nil {
				return nil, e
			}
			old, e := one(ctx, tx, `SELECT to_jsonb(c) FROM operations_p13_strategy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, x["operationId"])
			if e != nil {
				return nil, e
			}
			if old != nil {
				return old, sameCommand(old)
			}
			current, e := one(ctx, tx, `SELECT to_jsonb(r) FROM operations_p13_strategy_runs_v1 r WHERE endpoint=$1 AND id=$2 FOR UPDATE`, s.Endpoint, id)
			if e != nil {
				return nil, e
			}
			if current == nil || current["operator_id"] != actor.ID || current["native_run_id"] != native["runId"] || current["effect_result"] != nil || has([]string{"completed", "no-action", "blocked"}, str(current["state"])) {
				return nil, fail("p13_run_not_paused", 409)
			}
			prior, e := many(ctx, tx, `SELECT to_jsonb(c) FROM(SELECT result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND kind='continue' AND input->>'runId'=$2)c`, s.Endpoint, id)
			if e != nil {
				return nil, e
			}
			for _, v := range prior {
				binding := obj(obj(v["result"])["continuation"])
				if binding == nil || binding["nativeRunId"] == native["runId"] && binding["pauseId"] == native["pauseId"] {
					return nil, fail("p13_pause_decision_already_recorded", 409)
				}
			}
			if s.Effects == nil {
				return nil, fail("p13_effects_not_configured", 503)
			}
			facts, e := s.Effects.InspectWithin(ctx, tx, str(row["execution_id"]), actor.ID, nil)
			if e != nil {
				return nil, e
			}
			qualified := same(facts["sourceVersion"], row["source_version"]) && same(facts["decisionRevision"], row["decision_revision"])
			for _, v := range obj(facts["facts"]) {
				qualified = qualified && v == true
			}
			if !qualified {
				return nil, fail("p13_current_qualification_changed", 409)
			}
			approved := x["confirmed"] == true || x["inputDecision"] == "proceed"
			var approvedBy, approvalRun any
			if approved {
				approvedBy, approvalRun = actor.ID, native["runId"]
			}
			result := clone(x)
			result["runId"] = id
			result["continuation"] = Object{"nativeRunId": native["runId"], "pauseId": native["pauseId"]}
			if _, e = tx.Exec(ctx, `UPDATE operations_p13_strategy_runs_v1 SET approved_by=$3,approval_native_run_id=$4,decision=coalesce($5,decision),updated_at=$6 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id, approvedBy, approvalRun, x["inputDecision"], s.now()); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO operations_p13_strategy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,'continue',$4,$5,$6)`, s.Endpoint, x["operationId"], actor.ID, expectedInput, result, s.now()); e != nil {
				return nil, e
			}
			return Object{"operation_id": x["operationId"], "result": result}, nil
		})
		if e != nil {
			return nil, e
		}
	}
	receipt, e := s.continuationReceipt(ctx, row, command, false)
	if e != nil {
		return nil, e
	}
	if receipt["state"] == "not-recorded" {
		if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "strategies.run", authorize) }); e != nil {
			return nil, e
		}
		native, e := s.nativeRead(ctx, row, false)
		if e != nil {
			return nil, e
		}
		if native["awaitingHuman"] != true || native["runId"] != receipt["nativeRunId"] || native["pauseId"] != receipt["pauseId"] {
			return nil, fail("p13_run_not_paused", 409)
		}
		if s.Effects == nil {
			return nil, fail("p13_effects_not_configured", 503)
		}
		facts, e := s.Effects.Inspect(ctx, str(row["execution_id"]), actor.ID, nil)
		if e != nil {
			return nil, e
		}
		qualified := same(facts["sourceVersion"], row["source_version"]) && same(facts["decisionRevision"], row["decision_revision"])
		for _, v := range obj(facts["facts"]) {
			qualified = qualified && v == true
		}
		if !qualified {
			return nil, fail("p13_current_qualification_changed", 409)
		}
		if _, e = s.Native.Continue(ctx, row, x); e != nil {
			return nil, e
		}
		receipt, e = s.continuationReceipt(ctx, row, command, false)
		if e != nil {
			return nil, e
		}
	}
	out, e := s.RunDetail(ctx, a, id)
	if e != nil {
		return nil, e
	}
	out["operationId"], out["continuation"] = x["operationId"], receipt
	return out, nil
}
