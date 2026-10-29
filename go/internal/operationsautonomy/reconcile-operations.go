package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// Reconcile only existing uncertain write calls. Tool's prior-call path is
// required to query the original operation and never creates a replacement.
func (s *Service) reconcileTaskOperations(ctx context.Context, taskID, runID string) (Object, error) {
	calls, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) ([]Object, error) {
		if _, e := s.DutyForTaskWithin(ctx, tx, taskID, "query"); e != nil {
			return nil, e
		}
		return many(ctx, tx, `SELECT to_jsonb(t) FROM (SELECT c.call_id,c.tool,c.arguments FROM operations_autonomy_tool_calls_v1 c LEFT JOIN operations_autonomy_receipts_v1 r ON r.endpoint=c.endpoint AND r.task_id=c.task_id AND r.operation_id=c.operation_id WHERE c.endpoint=$1 AND c.task_id=$2 AND c.tool=ANY($3::text[]) AND c.state<>'waiting-human' AND (c.state IN ('started','unknown') OR r.state='unknown' OR r.operation_id IS NULL) ORDER BY c.created_at,c.call_id LIMIT 20) t`, s.Endpoint, taskID, dutyWriters)
	})
	if e != nil {
		return nil, e
	}
	outcomes := []Object{}
	for _, c := range calls {
		v, err := s.Tool(ctx, Object{"taskId": taskID, "nativeRunId": runID, "callId": c["call_id"], "tool": c["tool"], "arguments": c["arguments"]}, false)
		state := "unknown"
		if err == nil && v != nil {
			state = str(v["effectState"])
			if state == "" {
				state = str(v["state"])
			}
		}
		outcomes = append(outcomes, Object{"callId": c["call_id"], "state": state})
	}
	return Object{"operations": outcomes, "basis": "original-operation-query"}, nil
}
