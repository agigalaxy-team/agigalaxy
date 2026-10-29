package operationsautonomy

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// DutyStrategyArtifactsWithin locates only this task's original created
// products. Historical results do not confer current publication authority.
func (s *Service) DutyStrategyArtifactsWithin(ctx context.Context, tx pgx.Tx, caller Actor, taskID string) (Object, error) {
	proof, err := s.DutyMetadata(caller)
	if err != nil || proof["taskId"] != taskID || proof["accessPurpose"] != "query" {
		return nil, fault.New("operations_autonomy_scope_denied", 403)
	}
	result := Object{"availability": "available", "items": []Object{}, "collectionComplete": true, "limit": 50, "basis": "same-task-original-creation", "currentPublishEligibility": "not-checked"}
	check := func() (Actor, Object, error) {
		actor, e := s.DutyForTaskWithin(ctx, tx, taskID, "query")
		if e != nil {
			return Actor{}, nil, e
		}
		actor, e = s.RequireDutyAction(ctx, tx, actor, "strategies.read", "query")
		if e != nil {
			return Actor{}, nil, e
		}
		metadata, e := s.DutyMetadata(actor)
		if e != nil || metadata["taskId"] != taskID || metadata["accessPurpose"] != "query" || !schemaUUID.MatchString(str(metadata["aiAccountId"])) {
			return Actor{}, nil, fault.New("operations_autonomy_scope_denied", 403)
		}
		return actor, metadata, nil
	}
	_, before, e := check()
	if e != nil {
		if fault.Status(e) == 403 {
			result["availability"], result["collectionComplete"] = "not-authorized", false
			return result, nil
		}
		return nil, e
	}
	rows, e := many(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT operation_id FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND task_id=$2 AND ai_account_id=$3 AND kind='ordinary-strategy-create-draft' AND state='completed' ORDER BY created_at,operation_id LIMIT 51) r`, s.Endpoint, taskID, before["aiAccountId"])
	if e != nil {
		return nil, e
	}
	if len(rows) > 0 && s.OriginalStrategyArtifactWithin == nil {
		result["availability"], result["collectionComplete"] = "unavailable", false
	} else {
		if len(rows) > 50 {
			result["availability"], result["collectionComplete"] = "partial", false
			rows = rows[:50]
		}
		items := []Object{}
		for _, row := range rows {
			id := str(row["operation_id"])
			value, err := s.OriginalStrategyArtifactWithin(ctx, tx, taskID, str(before["aiAccountId"]), id)
			if err != nil {
				if status := fault.Status(err); status != 403 && status != 404 && status != 409 && status != 503 {
					return nil, err
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
		result["items"] = items
	}
	_, after, e := check()
	if e != nil {
		if fault.Status(e) == 403 {
			result["items"], result["availability"], result["collectionComplete"] = []Object{}, "not-authorized", false
			return result, nil
		}
		return nil, e
	}
	if proof["aiAccountId"] != before["aiAccountId"] || proof["planId"] != before["planId"] || proof["planVersion"] != before["planVersion"] || before["aiAccountId"] != after["aiAccountId"] || before["planId"] != after["planId"] || before["planVersion"] != after["planVersion"] {
		return nil, fault.New("operations_autonomy_scope_denied", 403)
	}
	return result, nil
}
