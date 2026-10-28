package agentos

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"slices"
	"time"
	"unicode/utf8"
)

type ExecutionRuntime struct {
	Authority *Executions
	Client    *Client
}

func executionTransport(row Object) Execution {
	return Execution{ID: text(row, "id"), Mode: text(row, "mode"), Domain: text(row, "domain"), SessionID: text(row, "sessionId")}
}
func executionNativeRun(value any, runID, operationID string) Object {
	raw := object(value)["runs"]
	runs, _ := raw.([]any)
	if objects, ok := raw.([]Object); ok {
		for _, v := range objects {
			runs = append(runs, v)
		}
	}
	for _, v := range runs {
		r := object(v)
		if runID != "" && r["runId"] == runID || operationID != "" && r["operationId"] == operationID {
			return r
		}
	}
	return nil
}
func (r *ExecutionRuntime) Status(ctx context.Context, a operationspermissions.Actor) (Object, error) {
	if r == nil || r.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	s := r.Authority
	if e := s.ready(); e != nil {
		return nil, e
	}
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) { return s.humanWithin(ctx, tx, a, nil) }); e != nil {
		return nil, e
	}
	out := r.Client.Status(ctx)
	at := s.now().Unix()
	out["checkedAt"], out["readExpiresAt"] = at, at+30
	return out, nil
}
func (r *ExecutionRuntime) Get(ctx context.Context, a operationspermissions.Actor, id string) (Object, error) {
	if r == nil || r.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	meta, e := r.Authority.Get(ctx, a, id)
	if e != nil {
		return nil, e
	}
	status := r.Client.Status(ctx)
	state := "unavailable"
	var native any
	if status["state"] == "connected" && object(meta["execution"])["state"] != "stopped" {
		native, e = r.Client.Read(ctx, executionTransport(object(meta["execution"])))
		if e != nil {
			if fault.Status(e) == 403 {
				return nil, e
			}
			native = nil
		} else {
			state = "connected"
		}
	}
	if _, e = r.Authority.Get(ctx, a, id); e != nil {
		return nil, e
	}
	if status["state"] == "not-configured" {
		state = "not-configured"
	}
	if end, ok := index(object(native)["readExpiresAt"]); ok && end < executionNumber(meta, "readExpiresAt") {
		meta["readExpiresAt"] = end
	}
	meta["native"], meta["runtimeState"], meta["modelState"] = native, state, status["modelState"]
	return meta, nil
}
func (r *ExecutionRuntime) Operation(ctx context.Context, a operationspermissions.Actor, id string) (Object, error) {
	if r == nil || r.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	receipt, e := r.Authority.Operation(ctx, a, id)
	if e != nil {
		return nil, e
	}
	state := receipt["commandState"]
	delete(receipt, "commandState")
	if receipt["state"] == "not-recorded" || !slices.Contains([]string{"run", "review", "continue"}, text(receipt, "kind")) {
		return receipt, nil
	}
	if state == "not-started" {
		receipt["state"], receipt["native"] = "not-started", nil
		return receipt, nil
	}
	var native Object
	value, e := r.Client.Read(ctx, executionTransport(object(receipt["execution"])))
	if e != nil {
		if fault.Status(e) == 403 {
			return nil, e
		}
	} else {
		native = executionNativeRun(value, text(receipt, "runId"), id)
	}
	if _, e = r.Authority.Operation(ctx, a, id); e != nil {
		return nil, e
	}
	if native != nil && native["status"] != nil {
		state = native["status"]
	}
	if state == nil {
		state = "unknown"
	}
	receipt["state"], receipt["native"] = state, any(native)
	return receipt, nil
}
func parseExecutionRun(kind string, input Object) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_operations_agentos_request", 400) }
	if kind == "continue" {
		if !executionStrict(input, []string{"operationId", "runId", "confirmed"}, nil) || !validOperationID(text(input, "operationId")) || utf8.RuneCountInString(text(input, "runId")) < 1 || utf8.RuneCountInString(text(input, "runId")) > 128 {
			return invalid()
		}
		if _, ok := input["confirmed"].(bool); !ok {
			return invalid()
		}
		return Object{"operationId": input["operationId"], "runId": input["runId"], "confirmed": input["confirmed"]}, nil
	}
	if !slices.Contains([]string{"run", "review"}, kind) || !executionStrict(input, []string{"operationId", "message"}, nil) || !validOperationID(text(input, "operationId")) {
		return invalid()
	}
	message, ok := input["message"].(string)
	if !ok {
		return invalid()
	}
	message = executionTrim(message)
	if utf8.RuneCountInString(message) < 1 || utf8.RuneCountInString(message) > 12000 {
		return invalid()
	}
	return Object{"operationId": input["operationId"], "message": message}, nil
}
func (r *ExecutionRuntime) Command(ctx context.Context, a operationspermissions.Actor, id, kind string, input Object, authorize ExecutionAuthorize) (Object, error) {
	x, e := parseExecutionRun(kind, input)
	if e != nil {
		return nil, e
	}
	if r == nil || r.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	s := r.Authority
	if e = s.ready(); e != nil {
		return nil, e
	}
	if !validOperationID(id) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	if authorize == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if kind == "run" {
		status := r.Client.Status(ctx)
		if status["state"] != "connected" {
			return nil, fail("operations_agentos_not_configured", 503)
		}
		if status["modelState"] != "configured" {
			return nil, fail("operations_agentos_model_not_configured", 503)
		}
	}
	type command struct{ old, execution, receipt Object }
	saved, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (command, error) {
		if _, e := s.humanWithin(ctx, tx, a, authorize); e != nil {
			return command{}, e
		}
		row, actor, e := s.ownedWithin(ctx, tx, a, id)
		if e != nil {
			return command{}, e
		}
		if _, _, _, e = s.currentWithin(ctx, tx, id, ExecutionActorOptions{}); e != nil {
			return command{}, e
		}
		if kind == "review" && row.PreparedCommand == nil {
			return command{}, fail("operations_agentos_prepared_command_required", 409)
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))`, s.Endpoint+":"+text(x, "operationId")); e != nil {
			return command{}, e
		}
		var owner, execution, priorKind string
		var oldInput, result Object
		e = tx.QueryRow(ctx, `SELECT operator_id,execution_id::text,kind,input,result FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["operationId"]).Scan(&owner, &execution, &priorKind, &oldInput, &result)
		if e == nil {
			if owner != actor.ID || execution != id || priorKind != kind || !sameConversationJSON(oldInput, x) {
				return command{}, fail("operations_agentos_operation_conflict", 409)
			}
			return command{old: result, execution: row.View()}, nil
		}
		if e != pgx.ErrNoRows {
			return command{}, e
		}
		receipt := Object{"operationId": x["operationId"], "runId": nil, "state": "dispatching", "replayed": false}
		if kind == "continue" {
			receipt["runId"] = x["runId"]
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_agentos_commands_v1(id,endpoint,execution_id,kind,operator_id,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, x["operationId"], s.Endpoint, id, kind, actor.ID, x, receipt, s.now()); e != nil {
			return command{}, e
		}
		return command{receipt: receipt, execution: row.View()}, nil
	})
	if e != nil {
		return nil, e
	}
	transport := executionTransport(saved.execution)
	if saved.old != nil {
		current, e := r.Client.Read(ctx, transport)
		if e != nil {
			return nil, e
		}
		native := executionNativeRun(current, text(saved.old, "runId"), text(x, "operationId"))
		if _, e = s.Get(ctx, a, id); e != nil {
			return nil, e
		}
		out := Object{}
		for k, v := range saved.old {
			out[k] = v
		}
		out["operationId"], out["kind"], out["executionId"], out["native"], out["replayed"] = x["operationId"], kind, id, any(native), true
		if native != nil && native["status"] != nil {
			out["state"] = native["status"]
		}
		return out, nil
	}
	revalidate := func() error {
		_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
			fresh, e := s.humanWithin(ctx, tx, a, authorize)
			if e != nil {
				return fresh, e
			}
			if saved.execution["executorKind"] == "ai" {
				fresh, e = s.Permissions.HumanAIWithin(ctx, tx, fresh, text(saved.execution, "domain"), "execution", "workbench.read")
			}
			return fresh, e
		})
		return e
	}
	dispatch := func() (Object, error) {
		if e := revalidate(); e != nil {
			return nil, e
		}
		if _, e = s.Actor(ctx, id, ExecutionActorOptions{}); e != nil {
			return nil, e
		}
		var value any
		var err error
		if kind == "continue" {
			value, err = r.Client.Continue(ctx, transport, text(x, "runId"), x["confirmed"] == true)
		} else {
			message := text(x, "message")
			if kind == "review" {
				message = "执行已准备的操作"
			}
			value, err = r.Client.Run(ctx, transport, text(x, "operationId"), message, kind == "review")
		}
		if err != nil {
			return nil, err
		}
		native := object(value)
		run := native["run_id"]
		if run == nil {
			run = native["runId"]
		}
		out := Object{}
		for k, v := range saved.receipt {
			out[k] = v
		}
		out["operationId"], out["kind"], out["executionId"], out["runId"], out["state"], out["native"] = x["operationId"], kind, id, run, "accepted", Object{"runId": run, "status": native["status"]}
		if _, e = s.Pool.Exec(ctx, `UPDATE operations_agentos_commands_v1 SET result=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["operationId"], out); e != nil {
			return nil, e
		}
		if e = revalidate(); e != nil {
			return nil, e
		}
		return out, nil
	}
	result, e := dispatch()
	if e == nil {
		return result, nil
	}
	receipt := saved.receipt
	receipt["state"] = "unknown"
	if slices.Contains([]string{"operations_agentos_model_not_configured", "operations_agentos_authority_changed"}, fault.Code(e)) {
		receipt["state"] = "not-started"
	}
	persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, err := s.Pool.Exec(persist, `UPDATE operations_agentos_commands_v1 SET result=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, x["operationId"], receipt); err != nil {
		return nil, err
	}
	return nil, e
}
