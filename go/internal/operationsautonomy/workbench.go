package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math"
)

type BusinessReceipt struct {
	TaskID, OperationID, Action, State, Basis string
	TargetType, TargetID                      *string
	Details                                   Object
}

func validDetails(o Object) bool {
	if len(o) != 2 || o["counts"] == nil || o["items"] == nil {
		return false
	}
	counts := obj(o["counts"])
	if len(counts) != 2 || !nonnegative(counts["applied"]) || !nonnegative(counts["rejected"]) {
		return false
	}
	items, ok := o["items"].([]any)
	if !ok || len(items) > 100 {
		return false
	}
	for _, v := range items {
		r := obj(v)
		if len(r) != 5 || !has([]string{"post", "reply"}, str(r["kind"])) || !schemaUUID.MatchString(str(r["id"])) || !has([]string{"applied", "rejected"}, str(r["status"])) || r["code"] != nil && !safeCode.MatchString(str(r["code"])) || r["revision"] != nil && !nonnegative(r["revision"]) {
			return false
		}
		if _, ok := r["code"]; !ok {
			return false
		}
		if _, ok := r["revision"]; !ok {
			return false
		}
	}
	return true
}
func nonnegative(v any) bool {
	switch n := v.(type) {
	case int:
		return n >= 0
	case int64:
		return n >= 0 && n <= 9007199254740991
	case float64:
		return n >= 0 && n == math.Trunc(n) && n <= 9007199254740991
	}
	return false
}
func (s *Service) RecordBusinessReceiptWithin(ctx context.Context, tx pgx.Tx, in BusinessReceipt) error {
	if in.Details != nil {
		in.Details = obj(clone(in.Details))
	}
	if !schemaUUID.MatchString(in.TaskID) || !schemaUUID.MatchString(in.OperationID) || !has([]string{"completed", "failed", "unknown", "no-action"}, in.State) || in.Basis == "" || in.Details != nil && !validDetails(in.Details) {
		return fault.New("operations_autonomy_receipt_invalid", 400)
	}
	if _, e := s.taskWithin(ctx, tx, in.TaskID, ""); e != nil {
		return e
	}
	old, e := optional(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT action,target_type,target_id FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3)r`, s.Endpoint, in.TaskID, in.OperationID)
	if e != nil {
		return e
	}
	var targetType, targetID any
	if in.TargetType != nil {
		targetType = *in.TargetType
	}
	if in.TargetID != nil {
		targetID = *in.TargetID
	}
	if old != nil && (old["action"] != in.Action || old["target_type"] != targetType || old["target_id"] != targetID) {
		return fail("operations_autonomy_operation_conflict")
	}
	var details any
	if in.Details != nil {
		details = jsonText(in.Details)
	}
	if _, e := tx.Exec(ctx, `INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,target_type,target_id,state,basis,created_at,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(endpoint,task_id,operation_id) DO UPDATE SET state=EXCLUDED.state,basis=EXCLUDED.basis,details=COALESCE(EXCLUDED.details,operations_autonomy_receipts_v1.details) WHERE operations_autonomy_receipts_v1.state='unknown' OR operations_autonomy_receipts_v1.state=EXCLUDED.state`, uuid.NewString(), s.Endpoint, in.TaskID, in.OperationID, in.Action, in.TargetType, in.TargetID, in.State, in.Basis, s.now(), details); e != nil {
		return e
	}
	rows, e := many(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT state FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2)r`, s.Endpoint, in.TaskID)
	if e != nil {
		return e
	}
	business := "no-action"
	for _, r := range rows {
		if r["state"] == "unknown" {
			business = "unknown"
			break
		}
		if r["state"] == "failed" {
			business = "failed"
		} else if r["state"] == "completed" && business != "failed" {
			business = "completed"
		}
	}
	_, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET business_state=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, in.TaskID, business, s.now())
	return e
}

var usageKeys = []string{"calls", "inputTokens", "outputTokens", "totalTokens", "durationMs"}

func (s *Service) refreshUsageWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	r, e := s.taskWithin(ctx, tx, id, "")
	if e != nil {
		return nil, e
	}
	runs, e := many(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT usage FROM operations_autonomy_workbench_runs_v1 WHERE endpoint=$1 AND task_id=$2)r`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if r["source"] != "workbench" {
		runs = append([]Object{{"usage": r["primary_model_usage"]}}, runs...)
	}
	combined := Object{}
	for _, k := range usageKeys {
		total := float64(0)
		valid := len(runs) > 0
		for _, run := range runs {
			n, ok := obj(run["usage"])[k].(float64)
			if !ok || math.IsInf(n, 0) || math.IsNaN(n) || n < 0 {
				valid = false
				break
			}
			total += n
		}
		combined[k] = nil
		if valid {
			combined[k] = total
		}
	}
	_, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET model_usage=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id, jsonText(combined))
	return combined, e
}

type WorkbenchUpdate struct {
	OperationID                                      string
	TurnOperationID, NativeRunID, ModelState, Status *string
	Receipt                                          *BusinessReceipt
	Usage                                            Object
}

func (s *Service) UpdateWorkbenchWithin(ctx context.Context, tx pgx.Tx, in WorkbenchUpdate) (Object, error) {
	row, e := optional(ctx, tx, `SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t WHERE endpoint=$1 AND id=$2 AND (source='workbench' OR human_decision->>'kind'='takeover') FOR UPDATE`, s.Endpoint, in.OperationID)
	if e != nil || row == nil {
		return row, e
	}
	binding := obj(obj(row["configuration"])["externalWorkbench"])
	turnID := str(binding["turnOperationId"])
	if turnID == "" {
		turnID = str(row["id"])
	}
	if in.TurnOperationID != nil {
		turnID = *in.TurnOperationID
	}
	old, e := optional(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT native_run_id FROM operations_autonomy_workbench_runs_v1 WHERE endpoint=$1 AND task_id=$2 AND turn_operation_id=$3)r`, s.Endpoint, row["id"], turnID)
	if e != nil {
		return nil, e
	}
	if str(old["native_run_id"]) != "" && in.NativeRunID != nil && *in.NativeRunID != "" && old["native_run_id"] != *in.NativeRunID {
		return nil, fail("operations_autonomy_operation_conflict")
	}
	state := str(row["state"])
	if in.Status != nil {
		state = *in.Status
	}
	if !has([]string{"running", "waiting-human", "completed", "failed", "stopped", "unknown"}, state) {
		return nil, fault.New("invalid_operations_autonomy_request", 400)
	}
	model := row["model_state"]
	if in.ModelState != nil {
		model = *in.ModelState
	}
	var usage any
	if in.Usage != nil {
		usage = jsonText(in.Usage)
	}
	if _, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,native_run_id,model_state,state,usage,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(endpoint,task_id,turn_operation_id) DO UPDATE SET native_run_id=COALESCE(operations_autonomy_workbench_runs_v1.native_run_id,EXCLUDED.native_run_id),model_state=COALESCE($9,operations_autonomy_workbench_runs_v1.model_state),state=CASE WHEN $10 THEN EXCLUDED.state ELSE operations_autonomy_workbench_runs_v1.state END,usage=COALESCE(EXCLUDED.usage,operations_autonomy_workbench_runs_v1.usage),updated_at=EXCLUDED.updated_at`, s.Endpoint, row["id"], turnID, in.NativeRunID, model, state, usage, s.now(), in.ModelState, in.Status != nil); e != nil {
		return nil, e
	}
	if in.Receipt != nil {
		r := *in.Receipt
		r.TaskID = str(row["id"])
		if e = s.RecordBusinessReceiptWithin(ctx, tx, r); e != nil {
			return nil, e
		}
	}
	var prepared, processing, unknown, unavailable, cancelled, completed, bindingInvalid bool
	if e = tx.QueryRow(ctx, `SELECT * FROM public.galaxy_autonomy_workbench_card_states_v1($1,$2)`, s.Endpoint, row["id"]).Scan(&prepared, &processing, &unknown, &unavailable, &cancelled, &completed, &bindingInvalid); e != nil {
		return nil, e
	}
	var unknownReceipt bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND state='unknown')`, s.Endpoint, row["id"]).Scan(&unknownReceipt); e != nil {
		return nil, e
	}
	var pendingDecision bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_tool_calls_v1 c WHERE c.endpoint=$1 AND c.task_id=$2 AND c.state='waiting-human' AND NOT EXISTS(SELECT 1 FROM operations_autonomy_decisions_v1 d WHERE d.endpoint=c.endpoint AND d.task_id=c.task_id AND d.call_id=c.call_id AND d.operation_id=c.operation_id) AND NOT EXISTS(SELECT 1 FROM operations_autonomy_receipts_v1 r WHERE r.endpoint=c.endpoint AND r.task_id=c.task_id AND r.operation_id=c.operation_id AND r.state IN ('completed','failed','no-action') AND r.basis IN ('persisted-domain-operation-receipt','original-operation-query','persisted-ai-role-delegation-event')))`, s.Endpoint, row["id"]).Scan(&pendingDecision); e != nil {
		return nil, e
	}
	var cardFailureCode any
	// Current persisted facts take precedence over the previous derived task state.
	switch {
	case unknown || processing || unknownReceipt || bindingInvalid:
		state = "unknown"
	case prepared || pendingDecision:
		state = "waiting-human"
	case model == "completed" && unavailable:
		state = "failed"
		cardFailureCode = "operations_autonomy_card_confirmation_unavailable"
		if completed {
			cardFailureCode = "operations_autonomy_partial_card_confirmation_unavailable"
		}
	case model == "completed" && cancelled && !completed && !unavailable:
		state = "stopped"
	}
	if has(terminal, str(row["state"])) {
		state = str(row["state"])
		cardFailureCode = nil
	}
	combined, e := s.refreshUsageWithin(ctx, tx, str(row["id"]))
	if e != nil {
		return nil, e
	}
	latestTurn := str(binding["turnOperationId"])
	if latestTurn == "" {
		latestTurn = str(row["id"])
	}
	latest := row["source"] == "workbench" && turnID == latestTurn
	if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state=$3,code=COALESCE($10,code),model_state=CASE WHEN $9 THEN COALESCE($4,model_state) ELSE model_state END,native_run_id=CASE WHEN $9 THEN COALESCE($5,native_run_id) ELSE native_run_id END,model_usage=$6,completed_at=CASE WHEN $7 THEN COALESCE(completed_at,$8) ELSE completed_at END,revision=revision+1,updated_at=$8 WHERE endpoint=$1 AND id=$2`, s.Endpoint, in.OperationID, state, in.ModelState, in.NativeRunID, jsonText(combined), has([]string{"completed", "failed", "stopped"}, state), s.now(), latest, cardFailureCode); e != nil {
		return nil, e
	}
	return s.taskWithin(ctx, tx, str(row["id"]), "")
}

type WorkbenchBind struct {
	TaskID, OperatorID, Domain, AIAccountID, TurnOperationID string
	ConversationID, SessionID                                *string
	DryRun                                                   bool
}

func (s *Service) BindWorkbenchTaskWithin(ctx context.Context, tx pgx.Tx, in WorkbenchBind) (Object, error) {
	reference, e := s.taskWithin(ctx, tx, in.TaskID, "")
	if e != nil {
		return nil, e
	}
	config, e := s.configWithin(ctx, tx, str(reference["domain"]), " FOR SHARE")
	if e != nil {
		return nil, e
	}
	row, e := s.taskWithin(ctx, tx, in.TaskID, " FOR UPDATE")
	if e != nil {
		return nil, e
	}
	decision := obj(row["human_decision"])
	takeover := row["source"] != "workbench" && decision["kind"] == "takeover" && decision["operatorId"] == in.OperatorID
	cfg := obj(row["configuration"])
	binding := obj(cfg["externalWorkbench"])
	if binding == nil {
		binding = Object{"operatorId": nil}
		if takeover {
			binding["operatorId"] = in.OperatorID
		}
	}
	if row["domain"] != in.Domain || row["ai_account_id"] != in.AIAccountID || binding["operatorId"] != in.OperatorID || has(terminal, str(row["state"])) || (row["source"] == "workbench" && (row["mode"] != "human-ai" || decision["kind"] == "takeover")) || (row["source"] != "workbench" && (!takeover || config["enabled"] != true)) {
		return nil, fault.New("operations_autonomy_scope_denied", 403)
	}
	if str(binding["conversationId"]) != "" && (in.ConversationID == nil || binding["conversationId"] != *in.ConversationID) || str(binding["sessionId"]) != "" && (in.SessionID == nil || binding["sessionId"] != *in.SessionID) {
		return nil, fault.New("operations_autonomy_scope_denied", 403)
	}
	bindings := obj(cfg["versionBindings"])
	pinned := bindings["strategyVersionId"]
	if takeover {
		for _, v := range list(bindings["grants"]) {
			frozen := obj(v)
			g, e := optional(ctx, tx, `SELECT to_jsonb(g) FROM(SELECT version,enabled FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE)g`, s.Endpoint, frozen["id"])
			if e != nil {
				return nil, e
			}
			if g["enabled"] != true || g["version"] != frozen["version"] {
				return nil, fault.New("operations_autonomy_authorization_changed", 403)
			}
		}
	}
	plan := obj(cfg["plan"])
	if len(texts(plan["strategyIds"])) > 0 {
		head, e := optional(ctx, tx, `SELECT to_jsonb(h) FROM operations_p13_strategy_heads_v1 h WHERE endpoint=$1 FOR SHARE`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		if head["active_id"] == nil || head["paused"] == true || has(texts(head["blocked_version_ids"]), str(pinned)) {
			return nil, fail("operations_autonomy_strategy_stopped")
		}
		current, e := optional(ctx, tx, `SELECT to_jsonb(v) FROM(SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2)v`, s.Endpoint, head["active_id"])
		if e != nil {
			return nil, e
		}
		for _, id := range texts(plan["strategyIds"]) {
			found := false
			for _, v := range list(obj(current["configuration"])["strategies"]) {
				r := obj(v)
				found = found || r["id"] == id && r["enabled"] == true
			}
			if !found {
				return nil, fail("operations_autonomy_strategy_stopped")
			}
		}
	}
	scope := obj(obj(cfg["strategyExecution"])["resourceScope"])
	if scope["kind"] == "unresolved" || scope["kind"] == "selected" && len(texts(scope["resourceIds"])) == 0 {
		return nil, fail("operations_autonomy_strategy_not_ready")
	}
	newBinding := obj(clone(binding))
	newBinding["conversationId"], newBinding["sessionId"], newBinding["turnOperationId"] = in.ConversationID, in.SessionID, in.TurnOperationID
	cfg["externalWorkbench"] = newBinding
	if binding["turnOperationId"] != in.TurnOperationID && !in.DryRun {
		if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET configuration=$3,state=CASE WHEN source='workbench' THEN 'running' ELSE state END,human_decision=CASE WHEN source='workbench' THEN NULL ELSE human_decision END,primary_model_usage=CASE WHEN source<>'workbench' THEN COALESCE(primary_model_usage,model_usage) ELSE primary_model_usage END,code=NULL,dispatch_started_at=COALESCE(dispatch_started_at,$4),revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, in.TaskID, jsonText(cfg), s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,model_state,state,created_at,updated_at) VALUES($1,$2,$3,'not-started','running',$4,$4) ON CONFLICT(endpoint,task_id,turn_operation_id) DO NOTHING`, s.Endpoint, in.TaskID, in.TurnOperationID, s.now()); e != nil {
			return nil, e
		}
	}
	return Object{"taskId": in.TaskID, "goal": cfg["goal"], "purpose": cfg["purpose"], "planVersion": row["plan_version"], "promptVersion": row["prompt_version"], "strategyIds": plan["strategyIds"], "targetType": row["target_type"], "targetId": row["target_id"], "resourceScope": scope, "resourceIds": plan["resourceIds"], "actions": plan["actions"]}, nil
}
func (s *Service) TaskContinuationWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	row, e := s.taskWithin(ctx, tx, id, "")
	if e != nil {
		return nil, e
	}
	calls, e := many(ctx, tx, `SELECT to_jsonb(t) FROM(SELECT c.call_id,c.operation_id,r.state,r.basis,d.decision FROM operations_autonomy_tool_calls_v1 c LEFT JOIN operations_autonomy_receipts_v1 r ON r.endpoint=c.endpoint AND r.task_id=c.task_id AND r.operation_id=c.operation_id LEFT JOIN operations_autonomy_decisions_v1 d ON d.endpoint=c.endpoint AND d.task_id=c.task_id AND d.call_id=c.call_id AND d.operation_id=c.operation_id WHERE c.endpoint=$1 AND c.task_id=$2 AND c.state='waiting-human' ORDER BY c.created_at,c.call_id)t`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	decisions := []Object{}
	for _, c := range calls {
		if has([]string{"completed", "failed", "no-action"}, str(c["state"])) && has([]string{"persisted-domain-operation-receipt", "original-operation-query", "persisted-ai-role-delegation-event"}, str(c["basis"])) {
			decisions = append(decisions, Object{"callId": c["call_id"], "operationId": c["operation_id"], "state": c["state"], "basis": c["basis"]})
		} else if c["decision"] != nil {
			decisions = append(decisions, Object{"callId": c["call_id"], "operationId": c["operation_id"], "state": c["decision"], "basis": "persisted-human-decision"})
		}
	}
	allowed := row["source"] != "workbench" && str(row["native_run_id"]) != "" && !has([]string{"stopped", "failed", "blocked"}, str(row["state"])) && obj(row["human_decision"])["kind"] != "takeover" && len(calls) > 0 && len(decisions) == len(calls)
	return Object{"allowed": allowed, "decisions": decisions}, nil
}
