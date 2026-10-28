package agentos

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// All associations are read in bounded batches for this exact owner/session.
// A model-provided run ID never independently establishes a business turn.
func (s *Conversations) decorateRuns(ctx context.Context, row Conversation, runs []Object) ([]Object, error) {
	missing := []string{}
	for _, run := range runs {
		if run["operationId"] == nil && text(run, "runId") != "" {
			missing = append(missing, text(run, "runId"))
		}
	}
	if len(missing) > 0 {
		rows, err := s.Pool.Query(ctx, `SELECT min(id::text),COALESCE(native_run_id,result->>'runId') FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND result->>'cancelledOperationId' IS NULL AND COALESCE(native_run_id,result->>'runId')=ANY($4::text[]) GROUP BY COALESCE(native_run_id,result->>'runId') HAVING count(*)=1`, s.Endpoint, row.ID, row.OperatorID, missing)
		if err != nil {
			return nil, err
		}
		byRun := map[string]string{}
		for rows.Next() {
			var id, runID string
			if err = rows.Scan(&id, &runID); err != nil {
				rows.Close()
				return nil, err
			}
			byRun[runID] = id
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		for _, run := range runs {
			if id := byRun[text(run, "runId")]; run["operationId"] == nil && id != "" {
				run["operationId"] = id
			}
		}
	}
	ids, failed := []string{}, []string{}
	for _, run := range runs {
		if id := text(run, "operationId"); validOperationID(id) {
			ids = append(ids, id)
			if run["status"] == "ERROR" {
				failed = append(failed, id)
			}
		}
	}
	if len(ids) > 0 {
		rows, err := s.Pool.Query(ctx, `SELECT DISTINCT ON(result->>'cancelledOperationId') id::text,state,result->>'cancelledOperationId',created_at FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND result->>'cancelledOperationId'=ANY($4::text[]) ORDER BY result->>'cancelledOperationId',created_at DESC,id DESC`, s.Endpoint, row.ID, row.OperatorID, ids)
		if err != nil {
			return nil, err
		}
		cancellations := map[string]Object{}
		for rows.Next() {
			var id, state, turn string
			var at time.Time
			if err = rows.Scan(&id, &state, &turn, &at); err != nil {
				rows.Close()
				return nil, err
			}
			if state == "dispatching" || state == "accepted" || state == "unknown" {
				cancellations[turn] = Object{"operationId": id, "state": state, "recordedAt": at.UTC().Format("2006-01-02T15:04:05.000Z")}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		for _, run := range runs {
			if cancellation := cancellations[text(run, "operationId")]; cancellation != nil {
				run["cancellation"] = cancellation
			}
		}
	}
	if len(failed) == 0 {
		return runs, nil
	}
	rows, err := s.Pool.Query(ctx, `SELECT c.id::text,COALESCE(c.native_run_id,c.result->>'runId'),EXISTS(SELECT 1 FROM operations_agentos_conversation_tool_calls_v1 t WHERE t.endpoint=c.endpoint AND t.conversation_id=c.conversation_id AND t.turn_id=c.id AND t.tool IN ('run-authorized-work','prepare-operation')),EXISTS(SELECT 1 FROM operations_agentos_conversation_cards_v1 p WHERE p.endpoint=c.endpoint AND p.conversation_id=c.conversation_id AND p.turn_id=c.id AND p.operator_id=c.operator_id) FROM operations_agentos_conversation_commands_v1 c WHERE c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3 AND c.id=ANY($4::uuid[])`, s.Endpoint, row.ID, row.OperatorID, failed)
	if err != nil {
		return nil, err
	}
	type activity struct {
		run            *string
		business, card bool
	}
	activities := map[string]activity{}
	for rows.Next() {
		var id string
		var item activity
		if err = rows.Scan(&id, &item.run, &item.business, &item.card); err != nil {
			rows.Close()
			return nil, err
		}
		activities[id] = item
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, run := range runs {
		if run["status"] != "ERROR" || !validOperationID(text(run, "operationId")) {
			continue
		}
		state := "unknown"
		if item, ok := activities[text(run, "operationId")]; ok && item.run != nil && *item.run == text(run, "runId") {
			state = "check-records"
			if !item.business && !item.card {
				state = "not-started"
			}
		}
		run["businessActivity"] = Object{"state": state, "basis": "same-owner-turn-tool-and-card-ledger"}
	}
	return runs, nil
}

// A failed derived workbench projection must not roll back the native ACK or
// turn a dispatched operation into an apparently safe new submission.
func (s *Conversations) updateWorkbench(ctx context.Context, tx pgx.Tx, id string, fact Object) error {
	if s.UpdateWorkbenchWithin == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, "SAVEPOINT galaxy_workbench_projection"); err != nil {
		return err
	}
	if err := s.UpdateWorkbenchWithin(ctx, tx, id, fact); err != nil {
		if _, rollback := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT galaxy_workbench_projection"); rollback != nil {
			return rollback
		}
		if s.Diagnostic != nil {
			s.Diagnostic("operations_autonomy_projection_unavailable", id)
		}
	}
	_, err := tx.Exec(ctx, "RELEASE SAVEPOINT galaxy_workbench_projection")
	return err
}
