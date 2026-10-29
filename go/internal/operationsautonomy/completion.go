package operationsautonomy

import (
	"context"
	"github.com/jackc/pgx/v5"
)

var dutyWriters = []string{"execute-operation", "manage-ai-role", "manage-ai-prompt"}

func parseAssessment(args Object) error {
	if !closed(args, []string{"goalSatisfied", "remainingWork", "summary"}, nil) {
		return invalid()
	}
	satisfied, ok := args["goalSatisfied"].(bool)
	if !ok {
		return invalid()
	}
	remaining, ok := args["remainingWork"].([]any)
	if !ok || len(remaining) > 8 || satisfied != (len(remaining) == 0) {
		return invalid()
	}
	if _, ok = text(args["summary"], 0, 1000, false); !ok {
		return invalid()
	}
	for _, item := range remaining {
		x := obj(item)
		if !closed(x, []string{"kind", "description"}, nil) || !has([]string{"read", "action", "human"}, str(x["kind"])) {
			return invalid()
		}
		if _, ok = text(x["description"], 1, 240, true); !ok {
			return invalid()
		}
	}
	return nil
}

// completionWithin only uses the persisted original task, receipts and call IDs.
// The caller holds the task lock when writing a terminal decision.
func (s *Service) completionWithin(ctx context.Context, tx pgx.Tx, row Object, requireAssessment bool) (Object, error) {
	receipts, e := many(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT operation_id,state FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2) r`, s.Endpoint, row["id"])
	if e != nil {
		return nil, e
	}
	calls, e := many(ctx, tx, `SELECT to_jsonb(c) FROM (SELECT c.call_id,c.operation_id,c.tool,c.state,c.code,c.arguments,d.decision FROM operations_autonomy_tool_calls_v1 c LEFT JOIN operations_autonomy_decisions_v1 d ON d.endpoint=c.endpoint AND d.task_id=c.task_id AND d.call_id=c.call_id AND d.operation_id=c.operation_id WHERE c.endpoint=$1 AND c.task_id=$2) c`, s.Endpoint, row["id"])
	if e != nil {
		return nil, e
	}
	byID := map[string]string{}
	business := "not-started"
	unknown, failed, human := false, false, false
	for _, r := range receipts {
		state := str(r["state"])
		byID[str(r["operation_id"])] = state
		switch state {
		case "unknown":
			unknown = true
		case "failed":
			failed = true
		case "completed":
			if business != "completed" {
				business = "completed"
			}
		case "no-action":
			if business == "not-started" {
				business = "no-action"
			}
		}
	}
	var assessment Object
	pendingRead := false
	for _, c := range calls {
		if c["tool"] == "assess-task" && c["state"] == "completed" && c["code"] == "task-assessment-current" {
			assessment = obj(c["arguments"])
		}
		if !has(dutyWriters, str(c["tool"])) {
			if c["tool"] != "assess-task" && c["state"] == "started" {
				pendingRead = true
			}
			continue
		}
		state := str(c["state"])
		receipt := byID[str(c["operation_id"])]
		if state == "waiting-human" {
			if c["decision"] == nil && !has([]string{"completed", "failed", "no-action"}, receipt) {
				human = true
			}
			continue
		}
		if state == "started" || state == "unknown" || receipt == "" || receipt == "unknown" {
			unknown = true
		}
	}
	disposition, reason, next := "continue", "task-assessment-required", "继续当前任务并评估目标"
	if assessment != nil {
		reason = "task-work-remaining"
		if assessment["goalSatisfied"] == true {
			disposition, reason, next = "completed", "task-goal-satisfied", "完成任务"
		} else {
			for _, v := range list(assessment["remainingWork"]) {
				if obj(v)["kind"] == "human" {
					human = true
				}
			}
			next = "继续当前任务中的剩余工作"
		}
	}
	if !requireAssessment {
		disposition, reason, next = "completed", "task-check-complete", "完成任务"
	}
	if row["effective_check"] != true && business != "completed" && business != "no-action" && disposition == "completed" {
		disposition, reason, next = "continue", "effective-check-required", "执行有效业务检查"
	}
	if pendingRead && disposition == "completed" {
		disposition, reason, next = "continue", "read-in-progress", "等待原读取完成并重新评估"
	}
	if human || row["human_decision"] != nil {
		disposition, reason, next = "waiting-human", "human-decision-required", "等待原事项的具体人工决定"
	}
	if failed {
		disposition, reason, next = "failed", "business-receipt-failed", "核对失败的原业务回执"
		business = "failed"
	}
	if unknown {
		disposition, reason, next = "unknown", "original-operation-unknown", "核查原操作结果"
		business = "unknown"
	}
	return Object{"modelAssessment": assessment, "businessState": business, "eligibleToComplete": disposition == "completed", "disposition": disposition, "reasonCode": reason, "nextAction": next}, nil
}
