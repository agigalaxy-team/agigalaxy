package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// The target in the original receipt remains the authorized source strategy.
// This projection only locates independently verified products of that task.
func (s *Service) strategyArtifactsWithin(ctx context.Context, tx pgx.Tx, row Object, actor Actor) (Object, error) {
	result := Object{"availability": "available", "items": []Object{}, "collectionComplete": true, "limit": 50}
	rows, err := many(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT operation_id FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND task_id=$2 AND ai_account_id=$3 AND kind='ordinary-strategy-create-draft' AND state='completed' ORDER BY created_at,operation_id LIMIT 51) r`, s.Endpoint, row["id"], row["ai_account_id"])
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return result, nil
	}
	check := func() error {
		if _, err := s.actor(ctx, tx, actor, "strategies.read", nil); err != nil {
			return err
		}
		return s.checkTargetWithin(ctx, tx, actor, row, true)
	}
	if err = check(); err != nil {
		if fault.Status(err) == 403 || fault.Status(err) == 404 {
			result["availability"], result["collectionComplete"] = "not-authorized", false
			return result, nil
		}
		return nil, err
	}
	if s.OriginalStrategyArtifactWithin == nil {
		result["availability"], result["collectionComplete"] = "unavailable", false
		return result, nil
	}
	if len(rows) > 50 {
		result["availability"], result["collectionComplete"] = "partial", false
		rows = rows[:50]
	}
	items := []Object{}
	for _, candidate := range rows {
		id := str(candidate["operation_id"])
		value, e := s.OriginalStrategyArtifactWithin(ctx, tx, str(row["id"]), str(row["ai_account_id"]), id)
		if e != nil {
			if status := fault.Status(e); status != 403 && status != 404 && status != 409 && status != 503 {
				return nil, e
			}
			result["availability"], result["collectionComplete"] = "partial", false
			continue
		}
		valid := value != nil && value["operationId"] == id
		for _, key := range []string{"operationId", "sourceStrategyId", "sourceVersionId", "newStrategyId", "versionId"} {
			valid = valid && schemaUUID.MatchString(str(value[key]))
		}
		if !valid {
			result["availability"], result["collectionComplete"] = "partial", false
			continue
		}
		item := Object{}
		for _, key := range []string{"operationId", "sourceStrategyId", "sourceVersionId", "newStrategyId", "versionId"} {
			item[key] = value[key]
		}
		items = append(items, item)
	}
	if err = check(); err != nil {
		if fault.Status(err) == 403 || fault.Status(err) == 404 {
			result["availability"], result["collectionComplete"] = "not-authorized", false
			return result, nil
		}
		return nil, err
	}
	result["items"] = items
	return result, nil
}
