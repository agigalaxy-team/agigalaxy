package operationsautonomy

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func finite(v any) any {
	switch n := v.(type) {
	case float64:
		if n >= 0 && !math.IsNaN(n) && !math.IsInf(n, 0) {
			return n
		}
	case int64:
		if n >= 0 {
			return n
		}
	case int:
		if n >= 0 {
			return n
		}
	}
	return nil
}
func ptr(v any) *string {
	if v == nil {
		return nil
	}
	s := str(v)
	return &s
}
func (s *Service) workbenchHrefWithin(ctx context.Context, tx pgx.Tx, row Object, a Actor) (*string, error) {
	check := func() error {
		if _, e := s.actor(ctx, tx, a, "autonomy.control", nil); e != nil {
			return e
		}
		if _, e := s.actor(ctx, tx, a, "ai.use."+str(row["domain"]), nil); e != nil {
			return e
		}
		if s.AIWork == nil {
			return fault.New("operations_ai_work_unavailable", 503)
		}
		id := str(row["ai_account_id"])
		account, e := s.AIWork.AuthorizationWithin(ctx, tx, str(row["domain"]), &id)
		if e != nil {
			return e
		}
		if !account.Enabled {
			return dutyFail("operations_ai_work_disabled")
		}
		binding := obj(obj(row["configuration"])["externalWorkbench"])
		turn := str(binding["turnOperationId"])
		if turn == "" {
			turn = str(row["id"])
		}
		_, e = s.BindWorkbenchTaskWithin(ctx, tx, WorkbenchBind{TaskID: str(row["id"]), OperatorID: a.ID, Domain: str(row["domain"]), AIAccountID: id, ConversationID: ptr(binding["conversationId"]), SessionID: ptr(binding["sessionId"]), TurnOperationID: turn, DryRun: true})
		return e
	}
	if e := check(); e != nil {
		var f *fault.Error
		if errors.As(e, &f) && hasStatus(f.Status) {
			return nil, nil
		}
		return nil, e
	}
	href := "/admin?taskId=" + str(row["id"])
	return &href, nil
}
func hasStatus(status int) bool {
	return status == 400 || status == 403 || status == 404 || status == 409 || status == 410 || status == 503
}
func (s *Service) taskViewWithin(ctx context.Context, tx pgx.Tx, row Object, a Actor, includeReceipts, checkTarget bool) (Object, error) {
	if checkTarget {
		if e := s.checkTargetWithin(ctx, tx, a, row, true); e != nil {
			return nil, e
		}
	}
	continuation, e := s.TaskContinuationWithin(ctx, tx, str(row["id"]))
	if e != nil {
		return nil, e
	}
	calls, e := many(ctx, tx, `SELECT to_jsonb(c) FROM(SELECT call_id,operation_id,tool,code FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND state='waiting-human' ORDER BY created_at,call_id)c`, s.Endpoint, row["id"])
	if e != nil {
		return nil, e
	}
	pending := []Object{}
	for _, c := range calls {
		pending = append(pending, Object{"callId": c["call_id"], "operationId": c["operation_id"], "tool": c["tool"], "code": c["code"]})
	}
	href, e := s.workbenchHrefWithin(ctx, tx, row, a)
	if e != nil {
		return nil, e
	}
	controls := []string{}
	state := str(row["state"])
	decision := obj(row["human_decision"])
	if has(a.Permissions, "autonomy.control") {
		if !has(terminal, state) {
			if !has([]string{"paused", "waiting-human"}, state) {
				if !has([]string{"requested", "resuming"}, str(obj(row["control_state"])["phase"])) {
					controls = append(controls, "pause")
				}
				controls = append(controls, "takeover")
			} else if row["source"] != "workbench" && decision["kind"] != "takeover" {
				controls = append(controls, "takeover")
			}
			if row["source"] != "workbench" && has([]string{"paused", "waiting-human"}, state) && (row["dispatch_started_at"] == nil || row["native_continuable"] == true && continuation["allowed"] == true) {
				controls = append(controls, "resume")
			}
			controls = append(controls, "stop")
		}
		if row["source"] != "workbench" && row["mode"] == "ai" && has([]string{"failed", "unknown"}, state) && row["model_state"] == "failed" && row["human_decision"] == nil && str(row["native_run_id"]) != "" {
			controls = append(controls, "retry")
		}
		if row["dispatch_started_at"] != nil && state != "stopped" {
			controls = append(controls, "reconcile")
		}
	}
	receipts := []Object{}
	if includeReceipts {
		rows, e := many(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT operation_id,action,target_type,target_id,state,basis,details,created_at FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 ORDER BY created_at,operation_id)r`, s.Endpoint, row["id"])
		if e != nil {
			return nil, e
		}
		for _, r := range rows {
			receipts = append(receipts, Object{"operationId": r["operation_id"], "action": r["action"], "targetType": r["target_type"], "targetId": r["target_id"], "state": r["state"], "basis": r["basis"], "details": r["details"], "createdAt": iso(r["created_at"])})
		}
	}
	out := Object{}
	for result, k := range map[string]string{"id": "id", "taskId": "id", "operationId": "id", "title": "title", "domain": "domain", "source": "source", "mode": "mode", "state": "state", "modelState": "model_state", "businessState": "business_state", "revision": "revision", "controlRevision": "control_revision", "aiAccountId": "ai_account_id", "planId": "config_id", "configRevision": "config_revision", "promptVersion": "prompt_version", "planVersion": "plan_version", "delegationVersion": "delegation_version", "nativeRunId": "native_run_id", "nativeAttemptId": "native_attempt_id", "targetType": "target_type", "targetId": "target_id", "summary": "summary", "code": "code", "humanDecision": "human_decision"} {
		out[result] = row[k]
	}
	if row["native_attempt_id"] != nil {
		command, err := optional(ctx, tx, `SELECT to_jsonb(c) FROM (SELECT result FROM operations_autonomy_commands_v1 WHERE endpoint=$1 AND operation_id=$2 AND kind='control' AND result->'task'->>'id'=$3) c`, s.Endpoint, row["native_attempt_id"], row["id"])
		if err != nil {
			return nil, err
		}
		previous := obj(obj(command["result"])["previousAttempt"])
		if previous != nil {
			out["previousAttempt"] = Object{"nativeRunId": previous["nativeRunId"], "nativeAttemptId": previous["nativeAttemptId"], "sessionId": previous["sessionId"], "status": previous["status"], "modelState": previous["modelState"]}
		}
	}
	out["strategyVersionId"] = obj(obj(row["configuration"])["versionBindings"])["strategyVersionId"]
	if control := obj(row["control_state"]); control["kind"] == "manual-pause" && has([]string{"requested", "paused", "resuming", "ended"}, str(control["phase"])) {
		pause := Object{"phase": control["phase"], "pauseOperationId": control["pauseOperationId"], "nativeRunId": control["nativeRunId"]}
		if has([]string{"native-ended", "native-ended-after-checkpoint", "resumed", "stopped", "takeover", "natural-human-review"}, str(control["outcome"])) {
			pause["outcome"] = control["outcome"]
		}
		out["manualPause"] = pause
	}
	out["effects"], out["businessReceipts"], out["pendingCalls"], out["continuation"], out["workbenchHref"], out["availableControls"] = receipts, receipts, pending, continuation, href, controls
	if includeReceipts && checkTarget {
		report, err := s.taskReportWithin(ctx, tx, row, a)
		if err != nil {
			return nil, err
		}
		out["inspectionReport"], out["finalAnalysis"], out["assessmentSummary"] = report["inspectionReport"], report["finalAnalysis"], report["assessmentSummary"]
		artifacts, err := s.strategyArtifactsWithin(ctx, tx, row, a)
		if err != nil {
			return nil, err
		}
		out["strategyArtifacts"] = artifacts
	}
	usage := obj(row["model_usage"])
	out["calls"] = finite(usage["calls"])
	out["tokens"] = Object{"input": finite(usage["inputTokens"]), "output": finite(usage["outputTokens"]), "total": finite(usage["totalTokens"])}
	out["durationMs"] = finite(usage["durationMs"])
	for result, k := range map[string]string{"createdAt": "created_at", "updatedAt": "updated_at", "dueAt": "due_at", "startedAt": "started_at", "completedAt": "completed_at"} {
		out[result] = iso(row[k])
	}
	out["lastValidAt"] = nil
	if row["effective_check"] == true {
		out["lastValidAt"] = iso(row["completed_at"])
	}
	return out, nil
}
func (s *Service) GetTask(ctx context.Context, a Actor, id string) (Object, error) {
	if !schemaUUID.MatchString(id) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.read", nil)
		if e != nil {
			return nil, e
		}
		row, e := s.taskWithin(ctx, tx, id, "")
		if e != nil {
			return nil, e
		}
		task, e := s.taskViewWithin(ctx, tx, row, actor, true, true)
		if e != nil {
			return nil, e
		}
		if _, e = s.actor(ctx, tx, a, "autonomy.read", nil); e != nil {
			return nil, e
		}
		return s.stamp(Object{"task": task}), nil
	})
}
func parseTaskQuery(input Object) (Object, error) {
	if !closed(input, nil, []string{"page", "limit", "domain", "source", "state", "mode", "targetType", "targetId"}) {
		return nil, invalid()
	}
	x := obj(clone(input))
	if _, ok := x["page"]; !ok {
		x["page"] = 1
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = 25
	}
	if !integer(x["page"], 1, 100000) || !integer(x["limit"], 1, 100) {
		return nil, invalid()
	}
	for k, values := range map[string][]string{"domain": domains, "source": {"workbench", "routine", "event", "recovery"}, "state": {"queued", "running", "waiting-human", "paused", "completed", "failed", "stopped", "blocked", "unknown"}, "mode": {"code", "ai", "ai-human", "human-ai"}} {
		if v, ok := x[k]; ok && !has(values, str(v)) {
			return nil, invalid()
		}
	}
	typeValue, typeOK := x["targetType"]
	id, idOK := x["targetId"]
	if typeOK != idOK {
		return nil, invalid()
	}
	if typeOK {
		if !has([]string{"content-post", "content-reply", "content-section", "account", "business-account", "community-report", "chat-report", "feedback", "project", "method", "file-chat", "file-forum", "file-cleanup-plan", "messaging-plan", "recommendation-policy", "search-quality", "rule-key", "maintenance", "ai-role", "ai-role-assignment", "ai-work-account", "strategy", "strategy-configuration", "strategy-run"}, str(typeValue)) {
			return nil, invalid()
		}
		if _, ok := text(id, 1, 128, false); !ok {
			return nil, invalid()
		}
	}
	return x, nil
}
func (s *Service) Tasks(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parseTaskQuery(input)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.read", nil)
		if e != nil {
			return nil, e
		}
		values := []any{s.Endpoint}
		parts := []string{"t.endpoint=$1"}
		arg := func(v any) string { values = append(values, v); return fmt.Sprintf("$%d", len(values)) }
		for _, k := range []string{"domain", "source", "state", "mode"} {
			if v, ok := q[k]; ok {
				parts = append(parts, "t."+k+"="+arg(v))
			}
		}
		if q["targetType"] != nil {
			kind, id := arg(q["targetType"]), arg(q["targetId"])
			parts = append(parts, "((t.target_type="+kind+" AND t.target_id="+id+") OR EXISTS(SELECT 1 FROM("+taskSourceRefsSQL("t.endpoint", "t.id")+")refs WHERE refs.target_type="+kind+" AND refs.target_id="+id+"))")
		}
		where := ""
		for i, p := range parts {
			if i > 0 {
				where += " AND "
			}
			where += p
		}
		var total int
		var controlled *bool
		if e = tx.QueryRow(ctx, `SELECT count(*)::int,bool_or(t.target_type IS NOT NULL OR EXISTS(SELECT 1 FROM(`+taskSourceRefsSQL("t.endpoint", "t.id")+`)refs WHERE refs.target_type IS NOT NULL)) FROM operations_autonomy_tasks_v1 t WHERE `+where, values...).Scan(&total, &controlled); e != nil {
			return nil, e
		}
		limit, page := num(q["limit"]), num(q["page"])
		rows, e := many(ctx, tx, `SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t WHERE `+where+` ORDER BY t.created_at DESC,t.id DESC LIMIT `+arg(limit)+` OFFSET `+arg((page-1)*limit), values...)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		withheld := false
		for _, row := range rows {
			task, e := s.taskViewWithin(ctx, tx, row, actor, true, true)
			if e != nil {
				var f *fault.Error
				if !errors.As(e, &f) || f.Status != 403 && f.Status != 404 && f.Status != 409 && f.Status != 410 && f.Status != 503 {
					return nil, e
				}
				withheld = true
				continue
			}
			items = append(items, task)
		}
		if _, e = s.actor(ctx, tx, a, "autonomy.read", nil); e != nil {
			return nil, e
		}
		var totalOut any = total
		if withheld || controlled != nil && *controlled && (page != 1 || int64(total) > limit) {
			totalOut = nil
		}
		var next any
		if int64(len(rows)) == limit && page*limit < int64(total) {
			next = page + 1
		}
		availability := "available"
		if withheld {
			availability = "partial"
		}
		return s.stamp(Object{"items": items, "total": totalOut, "page": page, "limit": limit, "nextPage": next, "availability": availability}), nil
	})
}
