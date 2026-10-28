package agentos

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"regexp"
	"slices"
	"time"
	"unicode/utf8"
)

type ExecutionGateway struct {
	Authority      *Executions
	ReadContent    func(context.Context, operationspermissions.Actor, string, string) (Object, error)
	Visibility     func(context.Context, operationspermissions.Actor, string, string, Object) (Object, error)
	SearchSelected func(context.Context, Object, []ExecutionSourceRef) (Object, error)
}

var executionSourceVersion = regexp.MustCompile(`^[1-9][0-9]{0,9}$`)

func (g *ExecutionGateway) require(ctx context.Context, a operationspermissions.Actor, action string) error {
	_, e := postgres.InTx(ctx, g.Authority.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return g.Authority.RequireExecutionAction(ctx, tx, a, action)
	})
	return e
}
func executionContent(response Object) Object {
	if v := object(response["item"]); v != nil {
		return v
	}
	if v := object(response["content"]); v != nil {
		return v
	}
	return response
}
func (g *ExecutionGateway) AuthorizeNative(ctx context.Context, input Object) (Object, error) {
	if g == nil || g.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if !executionStrict(input, []string{"executionId", "operation"}, []string{"resourceType", "resourceId"}) || !validOperationID(text(input, "executionId")) || !slices.Contains([]string{"read", "run"}, text(input, "operation")) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	if v := input["resourceType"]; v != nil && !slices.Contains([]string{"agents", "workflows"}, text(input, "resourceType")) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	if v, has := input["resourceId"]; has && v != nil {
		value, ok := v.(string)
		if !ok || utf8.RuneCountInString(value) < 1 || utf8.RuneCountInString(value) > 100 {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
	}
	s := g.Authority
	if e := s.ready(); e != nil {
		return nil, e
	}
	value, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, _, _, e := s.currentWithin(ctx, tx, text(input, "executionId"), ExecutionActorOptions{InactiveRead: input["operation"] == "read"})
		if e != nil {
			return nil, e
		}
		resources := []string{"galaxy-" + row.Domain, "galaxy-prepared-review"}
		if input["resourceId"] != nil && !slices.Contains(resources, text(input, "resourceId")) {
			return nil, fail("operations_agentos_domain_mismatch", 403)
		}
		return Object{"allowed": true, "resourceIds": resources, "execution": row.View()}, nil
	})
	if e != nil {
		return nil, e
	}
	deadline := s.now().Unix() + 30
	rows, e := s.Pool.Query(ctx, `SELECT target_kind,target_id::text,source_version FROM operations_agentos_source_refs_v1 WHERE execution_id=$1`, input["executionId"])
	if e != nil {
		return nil, e
	}
	refs := []ExecutionSourceRef{}
	for rows.Next() {
		var r ExecutionSourceRef
		if e = rows.Scan(&r.Kind, &r.ID, &r.Version); e != nil {
			rows.Close()
			return nil, e
		}
		refs = append(refs, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	for _, ref := range refs {
		if g.ReadContent == nil {
			return nil, fail("operations_agentos_scope_unavailable", 503)
		}
		actor, e := s.Actor(ctx, text(input, "executionId"), ExecutionActorOptions{ResourceIDs: []string{ref.ID}, InactiveRead: input["operation"] == "read"})
		if e != nil {
			return nil, e
		}
		response, e := g.ReadContent(ctx, actor, ref.Kind, ref.ID)
		if e != nil {
			return nil, e
		}
		item := executionContent(response)
		if item["sourceState"] != "available" || executionNumber(item, "version") != ref.Version {
			return nil, fail("operations_agentos_source_changed", 409)
		}
		if at, ok := index(item["publishedUntil"]); ok && at < deadline {
			deadline = at
		}
	}
	value["readExpiresAt"] = deadline
	return value, nil
}
func (g *ExecutionGateway) Execute(ctx context.Context, input Object, caller *operationspermissions.Actor) (Object, error) {
	if g == nil || g.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	s := g.Authority
	if e := s.ready(); e != nil {
		return nil, e
	}
	if !executionStrict(input, []string{"executionId", "tool", "arguments", "runId", "callId"}, nil) || !validOperationID(text(input, "executionId")) || !slices.Contains([]string{"read-selected-content", "search-selected-public-content", "execute-prepared-command"}, text(input, "tool")) || object(input["arguments"]) == nil || utf8.RuneCountInString(text(input, "runId")) < 1 || utf8.RuneCountInString(text(input, "runId")) > 128 || !toolPairID.MatchString(text(input, "callId")) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	id, tool, run, call := text(input, "executionId"), text(input, "tool"), text(input, "runId"), text(input, "callId")
	args := object(input["arguments"])
	if tool == "search-selected-public-content" {
		if !executionStrict(args, []string{"kind", "query"}, []string{"after", "limit"}) || !slices.Contains([]string{"post", "reply"}, text(args, "kind")) {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
		query := executionTrim(text(args, "query"))
		if utf8.RuneCountInString(query) < 1 || utf8.RuneCountInString(query) > 160 {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
		normalized := Object{"query": query}
		for _, key := range []string{"after", "limit"} {
			if v, has := args[key]; has {
				n, ok := index(v)
				min, max := int64(0), int64(10000)
				if key == "limit" {
					min, max = 1, 30
				}
				if !ok || n < min || n > max {
					return nil, fail("invalid_operations_agentos_request", 400)
				}
				normalized[key] = n
			}
		}
		actor, e := s.Actor(ctx, id, ExecutionActorOptions{Caller: caller})
		if e != nil {
			return nil, e
		}
		if e = g.require(ctx, actor, "content.read"); e != nil {
			return nil, e
		}
		metadata, _ := s.ExecutionMetadata(actor)
		ids := executionStrings(metadata["resourceIds"])
		if len(ids) == 0 {
			return nil, fail("operations_agentos_scope_required", 400)
		}
		if g.SearchSelected == nil {
			return nil, fail("operations_agentos_search_not_configured", 503)
		}
		refs := []ExecutionSourceRef{}
		for _, id := range ids {
			refs = append(refs, ExecutionSourceRef{Kind: text(args, "kind"), ID: id})
		}
		result, e := g.SearchSelected(ctx, normalized, refs)
		if e != nil {
			return nil, e
		}
		if e = g.require(ctx, actor, "content.read"); e != nil {
			return nil, e
		}
		items := []any{}
		raw, _ := result["items"].([]any)
		if objects, ok := result["items"].([]Object); ok {
			for _, item := range objects {
				raw = append(raw, item)
			}
		}
		for _, v := range raw {
			item := object(v)
			if item["kind"] != args["kind"] || !slices.Contains(ids, text(item, "id")) {
				continue
			}
			var version any
			if value := text(item, "version"); validOperationID(value) || executionSourceVersion.MatchString(value) {
				version = value
			}
			items = append(items, Object{"kind": item["kind"], "id": item["id"], "sourceVersion": version})
		}
		var next any
		if n, ok := index(result["nextAfter"]); ok {
			next = n
		}
		return Object{"items": items, "nextAfter": next, "source": "meilisearch-selected-public-content", "qualification": "current-anonymous-public-reader"}, nil
	}
	if tool == "read-selected-content" {
		if !executionStrict(args, []string{"kind", "id"}, nil) || !slices.Contains([]string{"post", "reply"}, text(args, "kind")) || !validOperationID(text(args, "id")) {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
		actor, e := s.Actor(ctx, id, ExecutionActorOptions{ResourceIDs: []string{text(args, "id")}, Caller: caller})
		if e != nil {
			return nil, e
		}
		if g.ReadContent == nil {
			return nil, fail("operations_agentos_scope_unavailable", 503)
		}
		response, e := g.ReadContent(ctx, actor, text(args, "kind"), text(args, "id"))
		if e != nil {
			return nil, e
		}
		if e = g.require(ctx, actor, "content.read"); e != nil {
			return nil, e
		}
		item := executionContent(response)
		if item["sourceState"] == "available" {
			version, ok := index(item["version"])
			if !ok {
				return nil, fail("operations_agentos_source_changed", 409)
			}
			if _, e = s.Pool.Exec(ctx, `INSERT INTO operations_agentos_source_refs_v1(execution_id,target_kind,target_id,source_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, id, item["kind"], item["id"], version); e != nil {
				return nil, e
			}
			var original int64
			if e = s.Pool.QueryRow(ctx, `SELECT source_version FROM operations_agentos_source_refs_v1 WHERE execution_id=$1 AND target_kind=$2 AND target_id=$3`, id, item["kind"], item["id"]).Scan(&original); e != nil {
				return nil, e
			}
			if original != version {
				return nil, fail("operations_agentos_source_changed", 409)
			}
		}
		var title, body, visibility any
		if item["sourceState"] == "available" {
			body = item["body"]
			if item["kind"] == "post" {
				title = item["title"]
			}
		}
		if v := object(item["visibility"]); v != nil {
			visibility = Object{"hidden": v["hidden"], "version": v["version"]}
		}
		return Object{"kind": item["kind"], "id": item["id"], "version": item["version"], "sourceState": item["sourceState"], "title": title, "body": body, "visibility": visibility}, nil
	}
	if len(args) != 0 {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	type initial struct {
		saved, command Object
		operation      string
	}
	prepared, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (initial, error) {
		row, _, _, e := s.currentWithin(ctx, tx, id, ExecutionActorOptions{Caller: caller})
		if e != nil {
			return initial{}, e
		}
		command := row.PreparedCommand
		if command == nil {
			return initial{}, fail("operations_agentos_prepared_command_required", 409)
		}
		actor, e := s.ActorWithin(ctx, tx, id, ExecutionActorOptions{ResourceIDs: []string{text(command, "targetId")}, Caller: caller})
		if e != nil {
			return initial{}, e
		}
		action := "content.restore"
		if object(command["input"])["kind"] == "hide" {
			action = "content.hide"
		}
		if _, e = s.RequireExecutionAction(ctx, tx, actor, action); e != nil {
			return initial{}, e
		}
		if e = s.checkPriorDecision(ctx, tx, actor, command); e != nil {
			return initial{}, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912422))`, s.Endpoint+":"+id+":"+run+":"+call); e != nil {
			return initial{}, e
		}
		var oldTool, state, operation string
		var oldArgs, saved Object
		e = tx.QueryRow(ctx, `SELECT tool,state,operation_id::text,arguments,result FROM operations_agentos_tool_calls_v1 WHERE endpoint=$1 AND execution_id=$2 AND run_id=$3 AND call_id=$4`, s.Endpoint, id, run, call).Scan(&oldTool, &state, &operation, &oldArgs, &saved)
		if e == nil {
			if oldTool != tool || !sameConversationJSON(oldArgs, args) {
				return initial{}, fail("operations_agentos_operation_conflict", 409)
			}
			if state == "completed" {
				return initial{saved: saved}, nil
			}
			return initial{command: command, operation: operation}, nil
		}
		if e != pgx.ErrNoRows {
			return initial{}, e
		}
		operation = uuid.NewString()
		if _, e = tx.Exec(ctx, `INSERT INTO operations_agentos_tool_calls_v1(id,endpoint,execution_id,run_id,call_id,tool,state,operation_id,arguments,created_at) VALUES($1,$2,$3,$4,$5,$6,'running',$7,$8,$9)`, uuid.NewString(), s.Endpoint, id, run, call, tool, operation, args, s.now()); e != nil {
			return initial{}, e
		}
		return initial{command: command, operation: operation}, nil
	})
	if e != nil {
		return nil, e
	}
	if prepared.saved != nil {
		prepared.saved["replayed"] = true
		return prepared.saved, nil
	}
	command := prepared.command
	execute := func() (Object, error) {
		actor, e := s.Actor(ctx, id, ExecutionActorOptions{ResourceIDs: []string{text(command, "targetId")}, Caller: caller})
		if e != nil {
			return nil, e
		}
		if g.Visibility == nil {
			return nil, fail("operations_authorization_unavailable", 503)
		}
		x := Object{}
		for k, v := range object(command["input"]) {
			x[k] = v
		}
		x["operationId"] = prepared.operation
		response, e := g.Visibility(ctx, actor, text(command, "targetKind"), text(command, "targetId"), x)
		if e != nil {
			return nil, e
		}
		item := executionContent(response)
		replayed := false
		if response["replayed"] == true {
			replayed = true
		}
		result := Object{"operationId": prepared.operation, "kind": command["targetKind"], "id": command["targetId"], "visibility": item["visibility"], "replayed": replayed}
		action := "content.restore"
		if x["kind"] == "hide" {
			action = "content.hide"
		}
		if e = g.require(ctx, actor, action); e != nil {
			return nil, e
		}
		if _, e = s.Pool.Exec(ctx, `UPDATE operations_agentos_tool_calls_v1 SET state='completed',result=$5,code=NULL,completed_at=$6 WHERE endpoint=$1 AND execution_id=$2 AND run_id=$3 AND call_id=$4`, s.Endpoint, id, run, call, result, s.now()); e != nil {
			return nil, e
		}
		return result, nil
	}
	result, e := execute()
	if e == nil {
		return result, nil
	}
	code := fault.Code(e)
	if !slices.Contains([]string{"operations_source_changed", "operations_visibility_changed", "operations_source_unavailable", "operations_hide_expiry", "operations_agentos_authority_changed", "operations_agentos_execution_inactive", "operations_permission_denied"}, code) {
		code = "operations_agentos_tool_failed"
	}
	persist, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, recordErr := s.Pool.Exec(persist, `UPDATE operations_agentos_tool_calls_v1 SET state='unknown',code=$5 WHERE endpoint=$1 AND execution_id=$2 AND run_id=$3 AND call_id=$4`, s.Endpoint, id, run, call, code); recordErr != nil {
		return nil, recordErr
	}
	return nil, fail(code, fault.Status(e))
}

// Compile-time ownership check: all business consumers share this same proof.
var _ operationspermissions.ExecutionAuthority = (*Executions)(nil)

func (g *ExecutionGateway) PreparedEffectWithin(ctx context.Context, tx pgx.Tx, executionID, runID string) (Object, error) {
	if g == nil || g.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	var state, operation string
	e := tx.QueryRow(ctx, `SELECT state,operation_id::text FROM operations_agentos_tool_calls_v1 WHERE endpoint=$1 AND execution_id=$2 AND run_id=$3 AND call_id='p13-prepared-effect'`, g.Authority.Endpoint, executionID, runID).Scan(&state, &operation)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	return Object{"state": state, "operation_id": operation}, nil
}
func (g *ExecutionGateway) PreparedEffect(ctx context.Context, executionID, runID string) (Object, error) {
	if g == nil || g.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, g.Authority.Pool, func(tx pgx.Tx) (Object, error) { return g.PreparedEffectWithin(ctx, tx, executionID, runID) })
}
