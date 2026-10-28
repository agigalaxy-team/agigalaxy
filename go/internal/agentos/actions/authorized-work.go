package actions

import (
	"context"
	"crypto/sha256"
	"fmt"
	"slices"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// AuthorizedWork uses the existing grant-bound execution and tool-call ledger.
// A workbench invocation never creates an execution, grant or business command.
type AuthorizedWork struct {
	Gateway *agentos.ExecutionGateway
}

func (w *AuthorizedWork) ready() error {
	if w == nil || w.Gateway == nil || w.Gateway.Authority == nil || w.Gateway.Authority.Pool == nil || w.Gateway.Authority.Permissions == nil || w.Gateway.ReadContent == nil {
		return fail("operations_agentos_conversation_not_ready", 503)
	}
	return nil
}

func (w *AuthorizedWork) now() int64 {
	if w.Gateway.Authority.Now != nil {
		return w.Gateway.Authority.Now().Unix()
	}
	return (&Service{}).now()
}

func (w *AuthorizedWork) human(ctx context.Context, a Actor, domain, purpose string) (Actor, error) {
	s := w.Gateway.Authority
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
		return s.Permissions.HumanAIWithin(ctx, tx, a, domain, purpose, "workbench.read")
	})
}

// Execute is the ConversationTools consumer. The conversation binding, current
// human and fixed AI account are established by its original caller.
func (w *AuthorizedWork) Execute(ctx context.Context, a Actor, row agentos.Conversation, input Object) (Object, error) {
	args := obj(input["arguments"])
	switch input["tool"] {
	case "list-authorized-work":
		if args == nil || len(args) != 0 {
			return nil, invalid()
		}
		return w.List(ctx, a, row.Domain)
	case "run-authorized-work":
		if args == nil || len(args) != 1 || !validID(str(args["executionId"])) {
			return nil, invalid()
		}
		return w.Run(ctx, a, row.Domain, str(args["executionId"]))
	default:
		return nil, invalid()
	}
}

func (w *AuthorizedWork) List(ctx context.Context, a Actor, domain string) (Object, error) {
	if e := w.ready(); e != nil {
		return nil, e
	}
	finish := func(items []any, complete bool, expiry int64, availability string) (Object, error) {
		preparer, e := w.human(ctx, a, domain, "prepare")
		if e != nil {
			return nil, e
		}
		return Object{"items": items, "basis": Object{"scope": "owned-explicit-authorized-work", "complete": complete, "availability": availability},
			"humanPreparation": Object{"tool": "prepare-operation", "availableKinds": operationsai.Capabilities(domain, preparer.Permissions)["preparableKinds"], "requiresAuthorizedExecution": false, "requiresHumanConfirmation": true, "objectEligibility": "checked-when-preparing"},
			"checkedAt":        w.now(), "readExpiresAt": min(expiry, w.now()+30)}, nil
	}
	actor, e := w.human(ctx, a, domain, "execution")
	if e != nil {
		if fault.Status(e) == 403 && fault.Code(e) == "operations_permission_denied" {
			return finish([]any{}, false, w.now()+30, "not-authorized")
		}
		return nil, e
	}
	supported := append([]string{"content.read", "content.hide", "content.restore"}, w.Gateway.Authority.Supported...)
	allowed := false
	for _, permission := range actor.Permissions {
		allowed = allowed || slices.Contains(supported, permission)
	}
	if !allowed {
		return finish([]any{}, false, w.now()+30, "not-authorized")
	}
	directory, e := w.Gateway.Authority.List(ctx, actor)
	if e != nil {
		if fault.Status(e) == 403 && fault.Code(e) == "operations_permission_denied" {
			return finish([]any{}, false, w.now()+30, "not-authorized")
		}
		return nil, e
	}
	result, expiry := []any{}, w.now()+30
	entries := items(directory["items"])
	for _, entry := range entries {
		x := obj(entry)
		if x["executorKind"] != "ai" || x["state"] != "active" || x["hasPreparedCommand"] != true || x["domain"] != domain {
			continue
		}
		item, e := w.Inspect(ctx, actor, str(x["id"]))
		if e != nil {
			if !slices.Contains([]int{403, 404, 409, 410}, fault.Status(e)) {
				return nil, e
			}
			item = Object{"executionId": x["id"], "domain": x["domain"], "target": nil, "action": nil, "available": false, "code": "operations_agentos_work_unavailable"}
		} else {
			expiry = min(expiry, num(item["readExpiresAt"]))
		}
		result = append(result, item)
	}
	return finish(result, len(entries) < 100, expiry, "available")
}

func (w *AuthorizedWork) Inspect(ctx context.Context, operator Actor, id string) (Object, error) {
	if e := w.ready(); e != nil {
		return nil, e
	}
	s := w.Gateway.Authority
	stored, e := s.Get(ctx, operator, id)
	if e != nil {
		return nil, e
	}
	execution, command := obj(stored["execution"]), obj(stored["preparedAction"])
	if command == nil {
		return nil, fail("operations_agentos_prepared_command_required", 409)
	}
	actor, e := s.Actor(ctx, id, agentos.ExecutionActorOptions{ResourceIDs: []string{str(command["targetId"])}, Caller: &operator})
	if e != nil {
		return nil, e
	}
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.RequireExecutionAction(ctx, tx, actor, "content.read") })
	if e != nil {
		return nil, e
	}
	response, e := w.Gateway.ReadContent(ctx, actor, str(command["targetKind"]), str(command["targetId"]))
	if e != nil {
		return nil, e
	}
	item := obj(response["content"])
	var strategy *string
	e = s.Pool.QueryRow(ctx, `SELECT id::text FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND execution_id=$2 LIMIT 1`, s.Endpoint, id).Scan(&strategy)
	if e != nil && e != pgx.ErrNoRows {
		return nil, e
	}
	var review bool
	if e = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND execution_id=$2 AND kind='review')`, s.Endpoint, id).Scan(&review); e != nil {
		return nil, e
	}
	prior := true
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) { return true, s.CheckPriorDecisionWithin(ctx, tx, actor, command) })
	if e != nil {
		if fault.Code(e) != "operations_agentos_human_review_required" {
			return nil, e
		}
		prior = false
	}
	input, visibility, caps := obj(command["input"]), obj(item["visibility"]), obj(item["capabilities"])
	sourceMatches := item["sourceState"] == "available" && same(item["version"], input["expectedVersion"]) && same(visibility["version"], input["expectedRevision"])
	can, temporal := caps["canRestore"], input["kind"] == "restore"
	if input["kind"] == "hide" {
		can = caps["canHide"]
	}
	maxHide, safeMax := integer(item["maxHideSeconds"])
	if safeMax && num(input["until"]) > w.now() && num(input["until"]) <= w.now()+maxHide {
		temporal = true
	}
	available := sourceMatches && can == true && temporal && prior && strategy == nil && !review
	var code, runID any
	if strategy != nil {
		code, runID = "operations_agentos_workflow_bound", *strategy
	} else if review || !prior {
		code = "operations_agentos_human_review_required"
	} else if !available {
		code = "operations_agentos_work_unavailable"
	}
	fallback := "公开回复"
	if command["targetKind"] == "post" {
		fallback = "公开帖子"
	}
	expiry := w.now()
	if item["publishedUntil"] != nil {
		expiry = num(item["publishedUntil"])
	}
	return Object{"executionId": id, "domain": execution["domain"], "action": "content." + str(input["kind"]),
		"target":    Object{"kind": command["targetKind"], "id": command["targetId"], "label": label(item["title"], fallback), "href": "/admin/operations/community?tab=posts&contentKind=" + str(command["targetKind"]) + "&id=" + str(command["targetId"])},
		"available": available, "code": code, "strategyRunId": runID, "checkedAt": w.now(), "readExpiresAt": min(w.now()+30, expiry)}, nil
}

func (w *AuthorizedWork) Run(ctx context.Context, operator Actor, domain, id string) (Object, error) {
	if e := w.ready(); e != nil {
		return nil, e
	}
	actor, e := w.human(ctx, operator, domain, "execution")
	if e != nil {
		return nil, e
	}
	s := w.Gateway.Authority
	stored, e := s.Get(ctx, actor, id)
	if e != nil {
		return nil, e
	}
	execution := obj(stored["execution"])
	if execution["executorKind"] != "ai" || execution["domain"] != domain {
		return nil, fail("operations_agentos_domain_mismatch", 403)
	}
	if _, e = s.Actor(ctx, id, agentos.ExecutionActorOptions{Caller: &actor}); e != nil {
		return nil, e
	}
	var completed Object
	e = s.Pool.QueryRow(ctx, `SELECT result FROM operations_agentos_tool_calls_v1 WHERE endpoint=$1 AND execution_id=$2 AND tool='execute-prepared-command' AND state='completed' ORDER BY created_at LIMIT 1`, s.Endpoint, id).Scan(&completed)
	if e != nil && e != pgx.ErrNoRows {
		return nil, e
	}
	if completed != nil {
		return Object{"state": "completed", "replayed": true, "result": safeReceipt(completed)}, nil
	}
	item, e := w.Inspect(ctx, actor, id)
	if e != nil {
		return nil, e
	}
	if item["available"] != true {
		state := "unavailable"
		if item["code"] == "operations_agentos_human_review_required" || item["code"] == "operations_agentos_workflow_bound" {
			state = "requires-human"
		}
		result := clone(item)
		result["state"] = state
		return result, nil
	}
	run := fmt.Sprintf("workbench-%x", sha256.Sum256([]byte(id)))
	result, e := w.Gateway.Execute(ctx, Object{"executionId": id, "runId": run, "callId": "workbench-prepared-command", "tool": "execute-prepared-command", "arguments": Object{}}, &actor)
	if e != nil {
		return nil, e
	}
	return Object{"state": "completed", "executionId": id, "result": safeReceipt(result)}, nil
}
