package main

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func stringPointer(value any) *string {
	if text, ok := value.(string); ok {
		return &text
	}
	return nil
}

func connectWorkbench(conversations *agentos.Conversations, autonomy *operationsautonomy.Service, logger *slog.Logger) {
	conversations.Tools = &agentos.ConversationTools{Conversations: conversations}
	conversations.ToolCards = conversations.Tools.Cards
	conversations.Tools.Prepare = func(ctx context.Context, actor operationspermissions.Actor, row agentos.Conversation, args agentos.Object, operationID string) (agentos.Object, error) {
		return conversations.Permissions.PrepareManagementAction(ctx, actor, row.Domain, args, operationID)
	}
	conversations.Tools.BoundedTaskWithin = func(ctx context.Context, tx pgx.Tx, row agentos.Conversation, command agentos.Object) error {
		result, _ := command["result"].(map[string]any)
		id, _ := result["taskId"].(string)
		if id == "" {
			return nil
		}
		if row.AIAccountID == nil {
			return fault.New("operations_ai_work_unassigned", 403)
		}
		op, _ := command["id"].(string)
		_, err := autonomy.BindWorkbenchTaskWithin(ctx, tx, operationsautonomy.WorkbenchBind{TaskID: id, OperatorID: row.OperatorID, Domain: row.Domain, AIAccountID: *row.AIAccountID, TurnOperationID: op, ConversationID: &row.ID, SessionID: &row.SessionID, DryRun: true})
		return err
	}
	conversations.Tools.BoundedProposalWithin = func(ctx context.Context, tx pgx.Tx, row agentos.Conversation, command, proposal agentos.Object) error {
		result, _ := command["result"].(map[string]any)
		id, _ := result["taskId"].(string)
		if id == "" {
			return nil
		}
		if row.AIAccountID == nil {
			return fault.New("operations_ai_work_unassigned", 403)
		}
		op, _ := command["id"].(string)
		task, err := autonomy.BindWorkbenchTaskWithin(ctx, tx, operationsautonomy.WorkbenchBind{TaskID: id, OperatorID: row.OperatorID, Domain: row.Domain, AIAccountID: *row.AIAccountID, TurnOperationID: op, ConversationID: &row.ID, SessionID: &row.SessionID, DryRun: true})
		if err != nil {
			return err
		}
		contains := func(value any, target any) bool {
			items, _ := value.([]any)
			for _, item := range items {
				if item == target {
					return true
				}
			}
			return false
		}
		if !contains(task["actions"], proposal["requiredAction"]) {
			return fault.New("operations_autonomy_workbench_scope_denied", 403)
		}
		scope, _ := task["resourceScope"].(map[string]any)
		if scope["kind"] != "all" && scope["kind"] != "eligible" && scope["kind"] != "selected" {
			return fault.New("operations_autonomy_workbench_scope_denied", 403)
		}
		if scope["kind"] == "selected" {
			target, _ := proposal["target"].(map[string]any)
			if target["id"] == nil || !contains(task["resourceIds"], target["id"]) {
				return fault.New("operations_autonomy_workbench_scope_denied", 403)
			}
		}
		return nil
	}
	conversations.Tools.SyncCardWithin = func(ctx context.Context, tx pgx.Tx, id string) error {
		var row agentos.Object
		if err := tx.QueryRow(ctx, `SELECT to_jsonb(c) FROM operations_agentos_conversation_cards_v1 c WHERE endpoint=$1 AND id=$2`, autonomy.Endpoint, id).Scan(&row); err != nil {
			return err
		}
		fact := operationsautonomy.WorkbenchCardFact(row)
		if fact == nil {
			return nil
		}
		turn, _ := row["turn_id"].(string)
		return conversations.UpdateWorkbenchWithin(ctx, tx, turn, fact)
	}
	conversations.Diagnostic = func(event, id string) { logger.Warn(event, "operationId", id) }
	conversations.LinkWorkbenchWithin = func(ctx context.Context, tx pgx.Tx, row agentos.Conversation, operationID, taskID string) error {
		if row.AIAccountID == nil {
			return fault.New("operations_ai_work_unassigned", 403)
		}
		if taskID != "" {
			_, err := autonomy.BindWorkbenchTaskWithin(ctx, tx, operationsautonomy.WorkbenchBind{TaskID: taskID, OperatorID: row.OperatorID, Domain: row.Domain, AIAccountID: *row.AIAccountID, TurnOperationID: operationID, ConversationID: &row.ID, SessionID: &row.SessionID})
			return err
		}
		_, err := autonomy.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: operationID, Domain: row.Domain, AIAccountID: *row.AIAccountID, ConversationID: &row.ID, SessionID: &row.SessionID, OperatorID: &row.OperatorID, ModelState: "not-started"})
		return err
	}
	conversations.UpdateWorkbenchWithin = func(ctx context.Context, tx pgx.Tx, operationID string, fact agentos.Object) error {
		var taskID *string
		if err := tx.QueryRow(ctx, "SELECT result->>'taskId' FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2", autonomy.Endpoint, operationID).Scan(&taskID); err != nil {
			return err
		}
		selected := operationID
		if taskID != nil && uuid.Validate(*taskID) == nil {
			selected = *taskID
		}
		usage, _ := fact["usage"].(map[string]any)
		update := operationsautonomy.WorkbenchUpdate{OperationID: selected, TurnOperationID: &operationID, NativeRunID: stringPointer(fact["nativeRunId"]), ModelState: stringPointer(fact["modelState"]), Status: stringPointer(fact["status"]), Usage: usage}
		if receipt, ok := fact["businessReceipt"].(map[string]any); ok {
			raw, err := json.Marshal(receipt)
			if err != nil {
				return err
			}
			var value operationsautonomy.BusinessReceipt
			if err = json.Unmarshal(raw, &value); err != nil {
				return err
			}
			update.Receipt = &value
		}
		_, err := autonomy.UpdateWorkbenchWithin(ctx, tx, update)
		return err
	}
	conversations.SyncWorkbenchRuns = func(ctx context.Context, row agentos.Conversation, runs []agentos.Object) error {
		_, err := postgres.InTx(ctx, autonomy.Pool, func(tx pgx.Tx) (bool, error) {
			ids := []string{}
			for _, run := range runs {
				if id, ok := run["operationId"].(string); ok && uuid.Validate(id) == nil {
					ids = append(ids, id)
				}
			}
			if len(ids) == 0 {
				return true, nil
			}
			rows, err := tx.Query(ctx, `SELECT id::text,COALESCE(native_run_id,result->>'runId') FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=ANY($4::uuid[]) AND result->>'cancelledOperationId' IS NULL`, autonomy.Endpoint, row.ID, row.OperatorID, ids)
			if err != nil {
				return false, err
			}
			known := map[string]*string{}
			for rows.Next() {
				var id string
				var nativeID *string
				if err = rows.Scan(&id, &nativeID); err != nil {
					rows.Close()
					return false, err
				}
				known[id] = nativeID
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return false, err
			}
			for _, run := range runs {
				id, _ := run["operationId"].(string)
				nativeID, found := known[id]
				if runID, ok := run["runId"].(string); !ok || runID == "" || !found || run["status"] == "REGENERATED" || nativeID != nil && *nativeID != runID {
					continue
				}
				if _, err = tx.Exec(ctx, "SAVEPOINT galaxy_workbench_projection"); err != nil {
					return false, err
				}
				if err = conversations.UpdateWorkbenchWithin(ctx, tx, id, operationsautonomy.WorkbenchRunFact(run)); err != nil {
					if _, rollback := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT galaxy_workbench_projection"); rollback != nil {
						return false, rollback
					}
					logger.Warn("operations_autonomy_projection_unavailable", "operationId", id)
				}
				if _, err = tx.Exec(ctx, "RELEASE SAVEPOINT galaxy_workbench_projection"); err != nil {
					return false, err
				}
			}
			return true, nil
		})
		return err
	}
}
