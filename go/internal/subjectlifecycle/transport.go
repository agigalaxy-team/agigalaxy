package subjectlifecycle

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SubjectErasure is an owning adapter's persisted, receipt-aware cleanup. An
// issued/unknown object operation must be reconciled by that adapter, never
// blindly sent again by this orchestration layer.
type SubjectErasure func(context.Context, string, int) (Object, error)
type DeletionTransports struct{ Chat, Attachments SubjectErasure }

// ExecuteDeletionWithTransports commits the exact approved primary DB operation
// before invoking external adapters. A transport failure cannot erase the DB
// receipt or pretend to roll back an external side effect. This maintenance
// entry does not change the end-user Service.Execute availability.
func ExecuteDeletionWithTransports(ctx context.Context, pool *pgxpool.Pool, command ExecutionCommand, at int64, options ExecutionOptions, adapters DeletionTransports, limit int) (Object, error) {
	execution, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return ExecuteWithin(ctx, tx, command, at, options) })
	if e != nil {
		return nil, e
	}
	invoke := func(adapter SubjectErasure, chat bool) Object {
		if adapter == nil {
			return Object{"state": "adapter-unavailable", "complete": false}
		}
		result, e := adapter(ctx, text(execution["subjectId"]), limit)
		if e != nil {
			return Object{"state": "pending-external-erasure", "complete": false, "retrySameCommand": true}
		}
		if chat {
			state := "pending-external-erasure"
			if result["complete"] == true {
				state = "adapter-scope-complete"
			}
			out := Object{"state": state}
			for k, v := range result {
				out[k] = v
			}
			return out
		}
		return result
	}
	return Object{"execution": execution, "transport": Object{"chat": invoke(adapters.Chat, true), "attachments": invoke(adapters.Attachments, false)}, "consistency": "database-receipt-and-current-transport-status; transport-pending-state-owned-by-chat", "serviceWideDeletionComplete": false, "backupsStarted": false}, nil
}
