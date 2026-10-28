package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
)

var nativeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var pauseID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}:[0-9]{1,6}$`)

func ParseStep(input Object) (Object, error) {
	if !closed(input, []string{"runId", "executionId", "nativeRunId", "phase"}, []string{"decision", "failure"}) || !uuidPattern.MatchString(str(input["runId"])) || !uuidPattern.MatchString(str(input["executionId"])) || !nativeID.MatchString(str(input["nativeRunId"])) || !has([]string{"prepare", "decision", "effect", "finished", "failed"}, str(input["phase"])) {
		return nil, invalid()
	}
	if v, ok := input["decision"]; ok && !has([]string{"proceed", "human-required", "needs-input", "no-action"}, str(v)) {
		return nil, invalid()
	}
	if v, ok := input["failure"]; ok && !has([]string{"native-unavailable", "workflow-failed"}, str(v)) {
		return nil, invalid()
	}
	return clone(input), nil
}
func (s *Service) executionCurrent(ctx context.Context, id string, active bool) error {
	if s.RequireExecutionWithin == nil {
		return fail("p13_native_binding_not_configured", 503)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) { return true, s.RequireExecutionWithin(ctx, tx, id, active) })
	return e
}
func (s *Service) storedHuman(ctx context.Context, tx pgx.Tx, id, action string) error {
	if s.StoredAuthority == nil {
		return fail("operations_authorization_unavailable", 503)
	}
	if e := s.StoredAuthority.Revalidate(ctx, tx, id, action); e != nil {
		return e
	}
	actor, e := s.StoredAuthority.PersonWithin(ctx, tx, id, false)
	if e != nil {
		return e
	}
	if actor.ID != id || actor.Endpoint != s.Endpoint || !has(actor.Permissions, action) {
		return fail("operations_permission_denied", 403)
	}
	return nil
}
func (s *Service) runRow(ctx context.Context, q Reader, id string) (Object, error) {
	return one(ctx, q, `SELECT to_jsonb(r) FROM operations_p13_strategy_runs_v1 r WHERE endpoint=$1 AND id=$2`, s.Endpoint, id)
}

type nativeBinding struct{ x, row, head, version, configuration, strategy Object }

func (s *Service) nativeBinding(ctx context.Context, input Object) (nativeBinding, error) {
	x, e := ParseStep(input)
	if e != nil {
		return nativeBinding{}, e
	}
	row, e := s.runRow(ctx, s.Pool, str(x["runId"]))
	if e != nil {
		return nativeBinding{}, e
	}
	if row == nil || row["execution_id"] != x["executionId"] || row["native_run_id"] != nil && row["native_run_id"] != x["nativeRunId"] {
		return nativeBinding{}, fail("p13_native_binding_denied", 403)
	}
	if e = s.executionCurrent(ctx, str(row["execution_id"]), true); e != nil {
		return nativeBinding{}, e
	}
	head, e := s.head(ctx, s.Pool)
	if e != nil {
		return nativeBinding{}, e
	}
	version, e := s.version(ctx, s.Pool, row["version_id"])
	if e != nil {
		return nativeBinding{}, e
	}
	live, e := s.version(ctx, s.Pool, head["active_id"])
	if e != nil {
		return nativeBinding{}, e
	}
	if version == nil || live == nil || head["paused"] == true || has(texts(head["blocked_version_ids"]), str(version["id"])) {
		return nativeBinding{}, fail("p13_strategy_paused", 409)
	}
	configuration, e := ParseConfiguration(obj(version["configuration"]))
	if e != nil {
		return nativeBinding{}, e
	}
	strategy := findStrategy(configuration, row["strategy_id"])
	if strategy == nil {
		return nativeBinding{}, fail("p13_strategy_not_found", 404)
	}
	bounds, e := ParseConfiguration(obj(live["configuration"]))
	if e != nil {
		return nativeBinding{}, e
	}
	domainEnabled := false
	for _, v := range list(bounds["domains"]) {
		domainEnabled = domainEnabled || obj(v)["key"] == strategy["domain"] && obj(v)["executionEnabled"] == true
	}
	if obj(bounds["common"])["automationEnabled"] != true || !domainEnabled {
		return nativeBinding{}, fail("p13_strategy_paused", 409)
	}
	return nativeBinding{x, row, head, version, configuration, strategy}, nil
}
func (s *Service) NativeContext(ctx context.Context, input Object) (Object, error) {
	if !closed(input, []string{"runId", "executionId", "operation"}, []string{"continuationOperationId"}) || !uuidPattern.MatchString(str(input["runId"])) || !uuidPattern.MatchString(str(input["executionId"])) || !has([]string{"read", "run"}, str(input["operation"])) {
		return nil, invalid()
	}
	if v, ok := input["continuationOperationId"]; ok && !uuidPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	row, e := s.runRow(ctx, s.Pool, str(input["runId"]))
	if e != nil {
		return nil, e
	}
	if row == nil || row["execution_id"] != input["executionId"] {
		return nil, fail("p13_native_binding_denied", 403)
	}
	if e = s.executionCurrent(ctx, str(row["execution_id"]), input["operation"] == "run"); e != nil {
		return nil, e
	}
	if input["operation"] == "run" {
		runID := row["native_run_id"]
		if runID == nil {
			runID = row["id"]
		}
		if _, e = s.nativeBinding(ctx, Object{"runId": row["id"], "executionId": row["execution_id"], "nativeRunId": runID, "phase": "prepare"}); e != nil {
			return nil, e
		}
	}
	out := Object{"runId": row["id"], "executionId": row["execution_id"], "sessionId": row["session_id"], "nativeRunId": row["native_run_id"], "workflow": Object{"id": WorkflowID, "version": 1}, "state": row["state"], "route": row["route"], "versionId": row["version_id"], "strategyId": row["strategy_id"]}
	if operationID, ok := input["continuationOperationId"]; ok {
		command, e := one(ctx, s.Pool, `SELECT to_jsonb(c) FROM(SELECT operator_id,input,result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2 AND kind='continue')c`, s.Endpoint, operationID)
		if e != nil {
			return nil, e
		}
		binding := obj(obj(command["result"])["continuation"])
		if command == nil || command["operator_id"] != row["operator_id"] || obj(command["input"])["runId"] != row["id"] || binding == nil || binding["nativeRunId"] != row["native_run_id"] {
			return nil, fail("p13_native_binding_denied", 403)
		}
		continuation := clone(binding)
		continuation["operationId"], continuation["runId"] = operationID, row["id"]
		if confirmed, ok := obj(command["input"])["confirmed"]; ok {
			continuation["confirmed"] = confirmed
		} else {
			continuation["inputDecision"] = obj(command["input"])["inputDecision"]
		}
		out["continuation"] = continuation
	}
	return out, nil
}
