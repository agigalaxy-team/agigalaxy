package workerconfig

import (
	"context"
	"log/slog"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsretention"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/jackc/pgx/v5"
)

// The original minute sweep invokes one bounded product cleanup transaction.
// Object-store reconciliation can remain pending; no global erasure is claimed.
func (r *Runtime) retentionMaintenance(ctx context.Context) {
	at := time.Now()
	if !r.nextRetentionCheck.IsZero() && at.Before(r.nextRetentionCheck) {
		return
	}
	r.nextRetentionCheck = at.Add(time.Minute)
	consumers, outcome := r.productRetentionConsumers(at.Unix())
	// External effects cannot be made atomic with the product transaction.
	// The owning bounded dispatcher commits its reservation before any first
	// DELETE and preserves unknown results for HEAD-only reconciliation.
	// Reuse this result below; do not select a second outcome batch.
	outcomeResult, err := outcome.PurgeExpired(ctx, 100)
	if err != nil {
		maintenanceFailure(r.configuration, "outcome-material-retention", err)
		return
	}
	consumers.OutcomeMaterials = func(context.Context, pgx.Tx, int64) (map[string]any, error) {
		return outcomeResult.(map[string]any), nil
	}
	result, err := postgres.InTx(ctx, r.Pool, func(tx pgx.Tx) (map[string]any, error) {
		out, err := subjectlifecycle.CleanupRetentionWithin(ctx, tx, at.Unix(), consumers)
		if err != nil {
			return nil, err
		}
		if r.Retention != nil {
			removed := out["removed"].(map[string]any)
			observer := *r.Retention
			previous := observer.CleanWithin
			// Two observed targets already ran above. Observe their actual counts
			// in the same tx instead of deleting a second batch of 100 rows.
			observer.CleanWithin = func(ctx context.Context, tx pgx.Tx, target string, at int64) (map[string]any, error) {
				switch target {
				case "private-conversation-archives":
					return map[string]any{"privateConversationArchives": removed["privateConversationArchives"]}, nil
				case "information-watches":
					return map[string]any{"informationChangeReceipts": removed["informationChangeReceipts"], "informationWatchReceipts": removed["informationWatchReceipts"]}, nil
				case "data-exports":
					if previous != nil {
						return previous(ctx, tx, target, at)
					}
					return operationsretention.CleanupExpiredExportsWithin(ctx, tx, at)
				default:
					return nil, fault.New("invalid_operations_product_request", 400)
				}
			}
			counts, e := observer.SweepWithin(ctx, tx, at.Unix())
			if e != nil {
				return nil, e
			}
			out["operationalMaintenance"] = counts
		}
		return out, nil
	})
	if err != nil {
		maintenanceFailure(r.configuration, "product-retention", err)
		return
	}
	if retentionChanged(result["removed"]) || retentionChanged(result["operationalMaintenance"]) {
		slog.Info("product_retention_cleanup", "counts", result)
	}
}

func retentionChanged(value any) bool {
	switch n := value.(type) {
	case map[string]any:
		for _, v := range n {
			if retentionChanged(v) {
				return true
			}
		}
	case int:
		return n > 0
	case int64:
		return n > 0
	case float64:
		return n > 0
	}
	return false
}
