package agentos

import (
	"context"
	"time"
)

// summaryTurnOutcomes only returns closed status facts for the current owner,
// conversation and fixed AI. Native data must match the original operation/run.
func (t *ConversationTools) summaryTurnOutcomes(ctx context.Context, row *Conversation, command *conversationCommand) (Object, error) {
	rows, e := t.Conversations.Pool.Query(ctx, `SELECT c.id::text,COALESCE(c.native_run_id,c.result->>'runId'),c.state,r.model_state FROM operations_agentos_conversation_commands_v1 c LEFT JOIN operations_autonomy_workbench_runs_v1 r ON r.endpoint=c.endpoint AND r.turn_operation_id=c.id AND (r.task_id=c.id OR r.task_id::text=c.result->>'taskId') WHERE c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3 AND c.result->>'cancelledOperationId' IS NULL AND (c.id=$4 OR c.created_at<$5) ORDER BY c.created_at DESC,c.id DESC LIMIT 10`, t.Conversations.Endpoint, row.ID, row.OperatorID, command.ID, command.CreatedAt)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	for rows.Next() {
		var id, state string
		var run, model *string
		if e = rows.Scan(&id, &run, &state, &model); e != nil {
			rows.Close()
			return nil, e
		}
		item := Object{"operationId": id, "runId": nil, "state": state, "modelState": nil, "failure": nil}
		if run != nil {
			item["runId"] = *run
		}
		if model != nil {
			item["modelState"] = *model
		}
		items = append(items, item)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	// Failure details are optional: an unavailable native reader never makes a
	// successful summary fail or supplies a guessed cause.
	if t.Conversations.Client != nil {
		bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		value, err := t.Conversations.Client.ReadConversation(bounded, row.Execution())
		if err == nil {
			runs, _ := object(value)["runs"].([]any)
			byRun := map[string]Object{}
			duplicates := map[string]bool{}
			for _, v := range runs {
				r := object(v)
				id := text(r, "runId")
				if id == "" {
					continue
				}
				if byRun[id] != nil {
					duplicates[id] = true
				}
				byRun[id] = r
			}
			counts := map[string]int{}
			for _, item := range items {
				if id := text(item, "runId"); id != "" {
					counts[id]++
				}
			}
			for _, item := range items {
				id := text(item, "runId")
				r := byRun[id]
				if id == "" || counts[id] != 1 || duplicates[id] || r == nil || text(r, "operationId") != "" && r["operationId"] != item["operationId"] {
					continue
				}
				status := text(r, "status")
				if !includesString([]any{"COMPLETED", "ERROR", "CANCELLED", "RUNNING", "PENDING", "PAUSED", "REGENERATED"}, status) {
					continue
				}
				item["nativeStatus"] = status
				f := object(r["failure"])
				if f == nil || f["stage"] != "model-request" || !includesString([]any{"rate-limit", "timeout", "connection", "context-limit", "service-unavailable", "request-rejected", "unknown"}, text(f, "category")) {
					continue
				}
				var reported any
				if v, ok := index(f["reportedStatus"]); ok && v >= 400 && v <= 599 {
					reported = v
				}
				item["failure"] = Object{"stage": "model-request", "category": f["category"], "reportedStatus": reported, "causeKnown": false}
			}
		}
	}
	return Object{"basis": "same-owner-fixed-ai-original-turns", "items": items, "missingCause": "unknown"}, nil
}
