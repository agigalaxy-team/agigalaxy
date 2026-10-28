package main

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsqueries"
	"github.com/jackc/pgx/v5"
)

// The model receives the current domain projection and original turn receipts,
// not a second workbench snapshot or caller-supplied conversation authority.
func connectWorkbenchSummary(conversations *agentos.Conversations, autonomy *operationsautonomy.Service, queries *operationsqueries.Service) {
	readers := agentos.SummaryContextReaders{BoundedTaskWithin: func(ctx context.Context, tx pgx.Tx, row agentos.Conversation, command agentos.Object) (agentos.Object, error) {
		result, _ := command["result"].(map[string]any)
		taskID, _ := result["taskId"].(string)
		turnID, _ := command["id"].(string)
		if row.AIAccountID == nil {
			return nil, fault.New("operations_ai_work_unassigned", 403)
		}
		return autonomy.ReadWorkbenchTaskWithin(ctx, tx, operationsautonomy.WorkbenchBind{TaskID: taskID, OperatorID: row.OperatorID, Domain: row.Domain, AIAccountID: *row.AIAccountID, TurnOperationID: turnID, ConversationID: &row.ID, SessionID: &row.SessionID, DryRun: true})
	}}
	queries.SummaryContext = func(ctx context.Context, a operationspermissions.Actor, domain string, bound operationsqueries.Object) (operationsqueries.Object, error) {
		return conversations.Tools.SummaryContext(ctx, a, domain, bound, readers)
	}
	queries.RecheckContext = conversations.Tools.RecheckContext
	conversations.Tools.Summary = queries.Summary
}
