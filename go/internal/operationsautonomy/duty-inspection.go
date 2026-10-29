package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// DutyCurrentInspection only releases metadata for the active duty identity.
// Controlled sources belonging to other tasks are withheld until their normal
// source qualification can be established; no audit body or prompt is read.
func (s *Service) DutyCurrentInspection(ctx context.Context, actor Actor, domain string) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.RequireDutyAction(ctx, tx, actor, "autonomy.read", "query")
		if e != nil {
			return nil, e
		}
		metadata, e := s.DutyMetadata(fresh)
		if e != nil || metadata["domain"] != domain {
			return nil, dutyFail("operations_autonomy_scope_denied")
		}
		accounts, e := many(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT w.id,w.domain,w.enabled,COALESCE(c.enabled,false) AS duty_enabled FROM operations_ai_work_accounts_v1 w LEFT JOIN operations_autonomy_configs_v1 c ON c.endpoint=w.endpoint AND c.domain=w.domain WHERE w.endpoint=$1 ORDER BY w.domain) r`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		candidates, e := many(ctx, tx, `SELECT to_jsonb(t) FROM (SELECT id,domain,state,model_state,business_state,target_type,target_id,event_ids FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND state IN ('queued','running','unknown','waiting-human','paused') ORDER BY (id=$2::uuid) DESC,created_at,id LIMIT 101) t`, s.Endpoint, metadata["taskId"])
		if e != nil {
			return nil, e
		}
		truncated := len(candidates) > 100
		if truncated {
			candidates = candidates[:100]
		}
		ids := []string{}
		for _, row := range candidates {
			ids = append(ids, str(row["id"]))
		}
		refs, e := s.taskSourceRefsForTasksWithin(ctx, tx, ids)
		if e != nil {
			return nil, e
		}
		tasks := []Object{}
		withheld := false
		partialReceipts := false
		counts := Object{}
		for _, row := range candidates {
			self := row["id"] == metadata["taskId"]
			if !self {
				if len(texts(row["event_ids"])) > 0 {
					withheld = true
					continue
				}
				sources := append([]Object(nil), refs[str(row["id"])]...)
				if str(row["target_type"]) != "" {
					sources = append(sources, Object{"target_type": row["target_type"], "target_id": row["target_id"]})
				}
				allowed, e := s.dutyInspectionSourcesWithin(ctx, tx, fresh, row, sources)
				if e != nil {
					return nil, e
				}
				if !allowed {
					withheld = true
					continue
				}
			}
			receipts, e := many(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT operation_id,state FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 ORDER BY created_at,operation_id LIMIT 51) r`, s.Endpoint, row["id"])
			if e != nil {
				return nil, e
			}
			receiptsComplete := len(receipts) <= 50
			if !receiptsComplete {
				partialReceipts = true
				receipts = receipts[:50]
			}
			effects := []Object{}
			for _, receipt := range receipts {
				effects = append(effects, Object{"operationId": receipt["operation_id"], "state": receipt["state"]})
			}
			state := str(row["state"])
			counts[state] = num(counts[state]) + 1
			tasks = append(tasks, Object{"id": row["id"], "domain": row["domain"], "state": row["state"], "modelState": row["model_state"], "businessState": row["business_state"], "self": self, "receipts": effects, "receiptsComplete": receiptsComplete})
		}
		if _, e = s.RequireDutyAction(ctx, tx, actor, "autonomy.read", "query"); e != nil {
			return nil, e
		}
		complete := !truncated && !withheld && !partialReceipts
		var exactCounts any
		if !truncated && !withheld {
			exactCounts = Object{"total": len(tasks), "byState": counts}
		}
		return Object{"availability": "available", "basis": "current-nonterminal-tasks-with-source-qualification", "accounts": accounts, "tasks": tasks, "taskCounts": exactCounts, "sampleLimit": 100, "sourceWithheld": withheld, "receiptCoverageComplete": !partialReceipts, "collectionComplete": complete, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30}, nil
	})
}

// Qualify only supported original source metadata using the current duty's
// own read authority. Event sources and unsupported kinds remain withheld.
func (s *Service) dutyInspectionSourcesWithin(ctx context.Context, tx pgx.Tx, actor Actor, row Object, sources []Object) (bool, error) {
	for _, source := range sources {
		targetType, id := str(source["target_type"]), str(source["target_id"])
		if id == "" {
			return false, nil
		}
		permission, kind := "", ""
		switch targetType {
		case "search-quality":
			permission = "search-quality.read"
		case "feedback", "content-post", "content-reply":
			kind = taskReadMap[targetType]
			permission = kindPermission[kind]
		default:
			return false, nil
		}
		fresh, err := s.RequireDutyAction(ctx, tx, actor, permission, "query")
		if err == nil && kind != "" {
			if s.ReadTargetWithin == nil {
				return false, nil
			}
			var result Object
			result, err = s.ReadTargetWithin(ctx, tx, fresh, str(row["domain"]), kind, id)
			if err == nil && result["availability"] != "available" {
				return false, nil
			}
		}
		if err == nil {
			_, err = s.RequireDutyAction(ctx, tx, actor, permission, "query")
		}
		if err != nil {
			if status := fault.Status(err); status == 403 || status == 404 || status == 503 {
				return false, nil
			}
			return false, err
		}
	}
	return true, nil
}
