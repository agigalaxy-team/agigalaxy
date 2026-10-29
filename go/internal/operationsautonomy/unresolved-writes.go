package operationsautonomy

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func isNoEffect(call Object) bool {
	if call["state"] != "not-admitted" {
		return false
	}
	if has([]string{"operations_autonomy_pause_requested", "operations_autonomy_original_operation_unknown"}, str(call["code"])) {
		return true
	}
	p := obj(obj(call["read_outcome"])["preDispatch"])
	return closed(p, []string{"phase", "basis"}, nil) && ((p["basis"] == "typed-pre-dispatch-rejection" && has([]string{"prepare", "bind", "qualify"}, str(p["phase"]))) || (p["basis"] == "fenced-original-absence" && p["phase"] == "not-dispatched"))
}

// Called under the original task lock. The current operation is excluded
// inside its own effect transaction, but no other unresolved write is.
func (s *Service) unresolvedDutyWriteWithin(ctx context.Context, tx pgx.Tx, row Object, exclude string) (bool, error) {
	receipts, err := many(ctx, tx, `SELECT to_jsonb(r) FROM operations_autonomy_receipts_v1 r WHERE endpoint=$1 AND task_id=$2 AND operation_id::text<>$3`, s.Endpoint, row["id"], exclude)
	if err != nil {
		return false, err
	}
	byID := map[string]Object{}
	for _, r := range receipts {
		if r["state"] == "unknown" {
			return true, nil
		}
		byID[str(r["operation_id"])] = r
	}
	calls, err := many(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_tool_calls_v1 c WHERE endpoint=$1 AND task_id=$2 AND operation_id::text<>$3 AND tool=ANY($4::text[])`, s.Endpoint, row["id"], exclude, dutyWriters)
	if err != nil {
		return false, err
	}
	for _, call := range calls {
		if call["state"] != "waiting-human" && !manualWriterSettled(call, byID[str(call["operation_id"])]) {
			return true, nil
		}
	}
	return false, nil
}
