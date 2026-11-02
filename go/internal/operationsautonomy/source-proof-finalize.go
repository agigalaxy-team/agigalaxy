package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

type sourceProofContextKey struct{}
type reportSnapshot struct {
	row      Object
	calls    []Object
	actor    Actor
	refs     []Object
	hasProof bool
	report   Object
}

// reportSnapshotWithin only reads the already-selected task. No external source
// reads occur until this transaction has released its connection.
func (s *Service) reportSnapshotWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) (*reportSnapshot, error) {
	actor, err := s.actor(ctx, tx, a, "autonomy.read", nil)
	if err != nil {
		return nil, err
	}
	row, err := s.taskWithin(ctx, tx, id, "")
	if err != nil {
		return nil, err
	}
	if err = s.checkTargetWithin(ctx, tx, actor, row, true); err != nil {
		return nil, err
	}
	calls, err := many(ctx, tx, `SELECT to_jsonb(c) FROM (SELECT call_id,operation_id,tool,state,code,arguments,read_outcome,updated_at FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 ORDER BY updated_at DESC,call_id DESC) c`, s.Endpoint, id)
	if err != nil {
		return nil, err
	}
	report, err := s.taskReportWithin(ctx, tx, row, actor)
	if err != nil {
		return nil, err
	}
	snap := &reportSnapshot{row: row, calls: calls, actor: actor, report: report}
	for _, call := range calls {
		tool := str(call["tool"])
		if !has([]string{"query-operations", "read-operation-object"}, tool) {
			continue
		}
		proof := obj(call["read_outcome"])
		if proof["sourceProofVersion"] == nil {
			continue
		}
		snap.hasProof = true
		if !integer(proof["sourceProofVersion"], 1, 1) || proof["complete"] != true {
			snap.refs = nil
			return snap, nil
		}
		refs, ok := proof["refs"].([]any)
		if !ok {
			snap.refs = nil
			return snap, nil
		}
		if proof["material"] == "none" {
			if len(refs) != 0 {
				snap.refs = nil
				return snap, nil
			}
			continue
		}
		if proof["material"] != "present" || len(refs) == 0 || s.QueryReadPermission == nil {
			snap.refs = nil
			return snap, nil
		}
		permission, e := s.QueryReadPermission(tool, obj(call["arguments"]))
		if e != nil || !s.reportAllowed(ctx, tx, actor, []string{permission}) {
			snap.refs = nil
			return snap, nil
		}
		for _, ref := range refs {
			value := obj(ref)
			if value == nil {
				snap.refs = nil
				return snap, nil
			}
			snap.refs = append(snap.refs, value)
		}
	}
	// A nil slice marks malformed or unauthorized proof; an empty non-nil one
	// is a verified no-material proof.
	if snap.refs == nil {
		snap.refs = []Object{}
	}
	return snap, nil
}

func (s *Service) finalizeTaskReports(ctx context.Context, actor Actor, out Object) {
	type candidate struct {
		task  Object
		force bool
	}
	tasks := []candidate{}
	if task := obj(out["task"]); task != nil {
		tasks = append(tasks, candidate{task, out["replayed"] == true})
	}
	if task := obj(obj(out["result"])["task"]); task != nil {
		tasks = append(tasks, candidate{task, true})
	}
	switch items := out["items"].(type) {
	case []Object:
		for _, task := range items {
			tasks = append(tasks, candidate{task, false})
		}
	case []any:
		for _, item := range items {
			if task := obj(item); task != nil {
				tasks = append(tasks, candidate{task, false})
			}
		}
	}
	for _, item := range tasks {
		task := item.task
		pending := item.force || task["_sourceProofPending"] == true
		delete(task, "_sourceProofPending")
		if !pending {
			continue
		}
		if task["finalAnalysis"] != nil {
			task["finalAnalysis"] = Object{"state": "withheld", "reason": "source-unverified"}
		}
		task["assessmentSummary"] = nil
		id := str(task["id"])
		if !schemaUUID.MatchString(id) {
			continue
		}
		snap, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (*reportSnapshot, error) { return s.reportSnapshotWithin(ctx, tx, actor, id) })
		if err != nil || snap == nil {
			continue
		}
		if !snap.hasProof || snap.report["sourceProofPending"] != true {
			task["finalAnalysis"], task["assessmentSummary"] = snap.report["finalAnalysis"], snap.report["assessmentSummary"]
			continue
		}
		if snap.refs == nil {
			continue
		}
		valid := true
		for start := 0; start < len(snap.refs); start += 300 {
			if s.RevalidateReadSources == nil {
				valid = false
				break
			}
			end := start + 300
			if end > len(snap.refs) {
				end = len(snap.refs)
			}
			result, e := s.RevalidateReadSources(ctx, snap.actor, str(snap.row["domain"]), snap.refs[start:end])
			if e != nil || result["valid"] != true {
				valid = false
				break
			}
			refs, ok := result["refs"].([]any)
			if !ok || len(refs) != end-start {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		report, err := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			current, e := s.reportSnapshotWithin(ctx, tx, actor, id)
			if e != nil {
				return nil, e
			}
			if !sameValue(snap.row, current.row) || !sameValue(snap.calls, current.calls) || current.refs == nil {
				return nil, nil
			}
			return s.taskReportWithin(context.WithValue(ctx, sourceProofContextKey{}, id), tx, current.row, current.actor)
		})
		if err == nil && report != nil {
			task["finalAnalysis"], task["assessmentSummary"] = report["finalAnalysis"], report["assessmentSummary"]
		}
	}
}
