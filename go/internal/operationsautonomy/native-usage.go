package operationsautonomy

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func nativeUsageNumber(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	case int:
		return float64(n)
	}
	return -1
}

func nativeUsageFromView(run Object) Object {
	tokens := obj(run["tokens"])
	return Object{"calls": finite(run["calls"]), "inputTokens": finite(tokens["input"]), "outputTokens": finite(tokens["output"]), "totalTokens": finite(tokens["total"]), "durationMs": finite(run["durationMs"])}
}

// validNativeUsage admits only the closed native snapshot, including nulls.
func validNativeUsage(value Object) bool {
	if !closed(value, usageKeys, nil) {
		return false
	}
	for _, key := range usageKeys {
		v := value[key]
		if v == nil {
			continue
		}
		if key == "durationMs" {
			if finite(v) == nil || nativeUsageNumber(v) > 9007199254740991 {
				return false
			}
		} else if !integer(v, 0, 9007199254740991) {
			return false
		}
	}
	return true
}

func nativeUsageNotOlder(old, value Object) bool {
	for _, key := range usageKeys {
		if old[key] != nil && (value[key] == nil || finite(old[key]) == nil || nativeUsageNumber(value[key]) < nativeUsageNumber(old[key])) {
			return false
		}
	}
	return true
}

// Store the whole original snapshot or none of it; never mix dimensions from
// different observations or let an older observation reduce a known total.
func (s *Service) storeNativeUsageWithin(ctx context.Context, tx pgx.Tx, row Object, runID string, value Object) error {
	if !validNativeUsage(value) || runID == "" || row["native_run_id"] != runID {
		return invalid()
	}
	old := obj(row["primary_model_usage"])
	if !nativeUsageNotOlder(old, value) {
		return nil
	}
	if old != nil && sameValue(old, value) {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET primary_model_usage=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], jsonText(value)); err != nil {
		return err
	}
	_, err := s.refreshUsageWithin(ctx, tx, str(row["id"]))
	return err
}
