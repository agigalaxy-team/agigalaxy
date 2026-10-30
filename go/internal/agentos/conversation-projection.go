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
		rows, e := s.Pool.Query(ctx, `SELECT id::text,result->>'origin',result->>'parentOperationId',COALESCE(result->>'logicalTurnId',result->>'retryOfOperationId',id::text) FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=ANY($4::uuid[])`, s.Endpoint, row.ID, row.OperatorID, ids)
		if e != nil {
			return nil, e
		}
		type lineage struct {
			origin, parent *string
			root           string
		}
		byID := map[string]lineage{}
		for rows.Next() {
			var id string
			var l lineage
			if e = rows.Scan(&id, &l.origin, &l.parent, &l.root); e != nil {
				rows.Close()
				return nil, e
			}
			byID[id] = l
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		for _, run := range runs {
			if l, ok := byID[text(run, "operationId")]; ok {
				if run["logicalTurnId"] == nil {
					run["logicalTurnId"] = l.root
				}
				run["origin"] = "user"
				run["parentOperationId"] = nil
				if l.origin != nil && *l.origin == "operation-feedback" {
					run["origin"] = "operation-feedback"
					run["parentOperationId"] = l.parent
				}
			}
		}
	}
	if err := s.projectConversationTimes(ctx, row, runs, ids); err != nil {
		return nil, err
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

// projectConversationTimes binds the user timestamp to the durable command and
// follows only verified same-owner retry links. A native timestamp is used only
// for old runs for which no Go operation was recorded.
func (s *Conversations) projectConversationTimes(ctx context.Context, row Conversation, runs []Object, ids []string) error {
	type root struct {
		run string
		at  time.Time
	}
	roots := map[string]root{}
	if len(ids) > 0 {
		rows, err := s.Pool.Query(ctx, `WITH RECURSIVE chain AS (
          SELECT c.id::text AS start_id, COALESCE(c.native_run_id,c.result->>'runId') AS start_run,
                 c.id::text AS id, c.result->>'retryOfOperationId' AS parent_id,
                 c.result->>'retryOfRunId' AS parent_run, c.created_at,
                 ARRAY[c.id::text] AS path, 0 AS depth
          FROM operations_agentos_conversation_commands_v1 c
          WHERE c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3
            AND c.id=ANY($4::uuid[]) AND c.result->>'cancelledOperationId' IS NULL
          UNION ALL
          SELECT ch.start_id,ch.start_run,p.id::text,p.result->>'retryOfOperationId',
                 p.result->>'retryOfRunId',p.created_at,ch.path || p.id::text,ch.depth+1
          FROM chain ch JOIN operations_agentos_conversation_commands_v1 p
            ON p.id::text=ch.parent_id AND p.endpoint=$1 AND p.conversation_id=$2 AND p.operator_id=$3
           AND p.result->>'cancelledOperationId' IS NULL
           AND COALESCE(p.native_run_id,p.result->>'runId')=ch.parent_run
          WHERE ch.depth<32 AND NOT p.id::text=ANY(ch.path)
        ) SELECT start_id,start_run,created_at FROM chain
          WHERE parent_id IS NULL AND parent_run IS NULL AND start_run IS NOT NULL`, s.Endpoint, row.ID, row.OperatorID, ids)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, run string
			var at time.Time
			if err = rows.Scan(&id, &run, &at); err != nil {
				rows.Close()
				return err
			}
			roots[id] = root{run, at}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	for _, run := range runs {
		run["sentAt"] = nil
		bound := run["operationId"] == nil
		if r, ok := roots[text(run, "operationId")]; ok && r.run == text(run, "runId") && r.at.Unix() >= 0 {
			bound = true
			run["sentAt"] = r.at.Unix()
		} else if run["operationId"] == nil {
			if at, ok := index(run["createdAt"]); ok {
				run["sentAt"] = at
			}
		}
		if !bound || run["status"] != "COMPLETED" {
			run["completedAt"] = nil
		} else if at, ok := index(run["completedAt"]); ok {
			run["completedAt"] = at
		} else {
			run["completedAt"] = nil
		}
	}
	return nil
}
