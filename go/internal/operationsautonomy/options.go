package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Options(ctx context.Context, a Actor) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.read", nil)
		if e != nil {
			return nil, e
		}
		availability := Object{"accounts": "not-authorized", "grants": "not-authorized"}
		accounts, grants := []Object{}, []Object{}
		if has(actor.Permissions, "ai.accounts.read") {
			availability["accounts"] = "available"
			if s.AIWork == nil {
				return nil, fault.New("operations_ai_work_unavailable", 503)
			}
			rows, e := many(ctx, tx, `SELECT to_jsonb(w) FROM(SELECT id,domain,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 ORDER BY domain)w`, s.Endpoint)
			if e != nil {
				return nil, e
			}
			for _, r := range rows {
				id := str(r["id"])
				current, e := s.AIWork.AuthorizationWithin(ctx, tx, str(r["domain"]), &id)
				if e != nil {
					return nil, e
				}
				accounts = append(accounts, Object{"id": r["id"], "domain": r["domain"], "name": r["name"], "enabled": r["enabled"], "permissions": current.Permissions})
			}
		}
		if has(actor.Permissions, "permissions.read") {
			availability["grants"] = "available"
			rows, e := many(ctx, tx, `SELECT to_jsonb(g) FROM(SELECT id,name,enabled,ai_account_id,permissions,executor_kind,mode,resource_ids,resource_scope_kind FROM operations_automation_grants_v1 WHERE endpoint=$1 ORDER BY name,id)g`, s.Endpoint)
			if e != nil {
				return nil, e
			}
			for _, r := range rows {
				grants = append(grants, Object{"id": r["id"], "name": r["name"], "enabled": r["enabled"], "aiAccountId": r["ai_account_id"], "permissions": r["permissions"], "executorKind": r["executor_kind"], "mode": r["mode"], "resourceScope": perms.AutomationResourceScope(r)})
			}
		}
		if _, e = s.actor(ctx, tx, a, "autonomy.read", nil); e != nil {
			return nil, e
		}
		actions := []Object{}
		for _, r := range perms.CatalogMetadata() {
			o := Object{}
			for _, k := range []string{"code", "label", "group", "groupLabel", "humanOnly", "sensitive"} {
				if v, ok := r[k]; ok {
					o[k] = v
				}
			}
			actions = append(actions, o)
		}
		return s.stamp(Object{"accounts": accounts, "grants": grants, "actions": actions, "eventTypes": []Object{{"id": "feedback.changed", "label": "使用反馈变化"}, {"id": "chat-report.changed", "label": "私聊案件变化"}, {"id": "community-report.changed", "label": "公开举报申诉变化"}, {"id": "operations.changed", "label": "运营业务已提交变化"}}, "availability": availability}), nil
	})
}
