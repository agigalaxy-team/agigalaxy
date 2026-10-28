package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"sort"
)

func (s *Service) SaveConfig(ctx context.Context, a Actor, domain string, input Object, authorize Authorize) (Object, error) {
	x, e := parseConfiguration(input)
	if e != nil {
		return nil, e
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.configure", authorize) }); e != nil {
		return nil, e
	}
	runtime := s.runtime(ctx)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.configure", authorize)
		if e != nil {
			return nil, e
		}
		intent := obj(clone(x))
		intent["domain"] = domain
		previous, e := s.previousWithin(ctx, tx, actor, str(x["operationId"]), "config", intent)
		if e != nil || previous != nil {
			return previous, e
		}
		if e = s.EnsureWithin(ctx, tx); e != nil {
			return nil, e
		}
		old, e := s.configWithin(ctx, tx, domain, " FOR UPDATE")
		if e != nil {
			return nil, e
		}
		if num(old["revision"]) != num(x["expectedRevision"]) {
			return nil, fail("operations_autonomy_revision_changed")
		}
		cfg := obj(clone(x))
		delete(cfg, "operationId")
		delete(cfg, "expectedRevision")
		candidate := obj(clone(old))
		candidate["configuration"], candidate["enabled"] = cfg, x["enabled"]
		if x["enabled"] == true {
			ready, e := s.readinessWithin(ctx, tx, candidate, runtime)
			if e != nil {
				return nil, e
			}
			if ready["ready"] != true {
				return nil, fail("operations_autonomy_not_ready")
			}
		}
		var next any
		if x["enabled"] == true {
			if old["enabled"] == true && sameValue(obj(old["configuration"])["schedule"], cfg["schedule"]) {
				next = old["next_due_at"]
			} else {
				v, e := NextDue(obj(cfg["schedule"]), s.now())
				if e != nil {
					return nil, e
				}
				next = v
			}
		}
		promptDelta, planDelta := 0, 0
		oldConfig := obj(old["configuration"])
		if oldConfig["prompt"] != cfg["prompt"] {
			promptDelta = 1
		}
		if !sameValue(oldConfig["plan"], cfg["plan"]) || oldConfig["purpose"] != cfg["purpose"] || oldConfig["mode"] != cfg["mode"] || oldConfig["goal"] != cfg["goal"] {
			planDelta = 1
		}
		row, e := one(ctx, tx, `UPDATE operations_autonomy_configs_v1 SET revision=revision+1,enabled=$3,configuration=$4,prompt_version=prompt_version+$5,plan_version=plan_version+$6,next_due_at=$7,enabled_at=CASE WHEN $3 AND NOT enabled THEN $8 ELSE enabled_at END,updated_by=$9,updated_by_ai_account_id=NULL,updated_at=$8 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_configs_v1)`, s.Endpoint, old["id"], x["enabled"], jsonText(cfg), promptDelta, planDelta, next, s.now(), actor.ID)
		if e != nil {
			return nil, e
		}
		if e = s.versionWithin(ctx, tx, row, actor.ID); e != nil {
			return nil, e
		}
		if x["enabled"] == false {
			if e = s.pauseForConfigWithin(ctx, tx, str(row["id"])); e != nil {
				return nil, e
			}
		}
		return s.recordWithin(ctx, tx, actor, str(x["operationId"]), "config", intent, Object{"operationId": x["operationId"], "config": present(row), "replayed": false})
	})
}
func (s *Service) pauseForConfigWithin(ctx context.Context, tx pgx.Tx, id string) error {
	_, e := tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='paused',native_continuable=false,lease_until=NULL,revision=revision+1,code='plan-disabled',updated_at=$3 WHERE endpoint=$1 AND config_id=$2 AND source<>'workbench' AND state IN ('queued','running')`, s.Endpoint, id, s.now())
	return e
}
func parseEnable(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "accounts"}, nil) || !schemaUUID.MatchString(str(input["operationId"])) {
		return nil, invalid()
	}
	x := obj(clone(input))
	items, ok := x["accounts"].([]any)
	if !ok || len(items) < 1 || len(items) > 5 {
		return nil, invalid()
	}
	seen := map[string]bool{}
	for _, v := range items {
		item := obj(v)
		if !closed(item, []string{"domain", "expectedRevision"}, nil) || !has(domains, str(item["domain"])) || !integer(item["expectedRevision"], 1, 9007199254740991) || seen[str(item["domain"])] {
			return nil, invalid()
		}
		seen[str(item["domain"])] = true
	}
	return x, nil
}
func (s *Service) Enable(ctx context.Context, a Actor, input Object, authorize Authorize) (Object, error) {
	x, e := parseEnable(input)
	if e != nil {
		return nil, e
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "autonomy.configure", authorize) }); e != nil {
		return nil, e
	}
	runtime := s.runtime(ctx)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, "autonomy.configure", authorize)
		if e != nil {
			return nil, e
		}
		previous, e := s.previousWithin(ctx, tx, actor, str(x["operationId"]), "enable", x)
		if e != nil || previous != nil {
			return previous, e
		}
		if e = s.EnsureWithin(ctx, tx); e != nil {
			return nil, e
		}
		items := list(x["accounts"])
		ordered := append([]any{}, items...)
		sort.Slice(ordered, func(i, j int) bool { return str(obj(ordered[i])["domain"]) < str(obj(ordered[j])["domain"]) })
		rows := []Object{}
		for _, v := range ordered {
			item := obj(v)
			r, e := s.configWithin(ctx, tx, str(item["domain"]), " FOR UPDATE")
			if e != nil {
				return nil, e
			}
			if num(r["revision"]) != num(item["expectedRevision"]) {
				return nil, fail("operations_autonomy_revision_changed")
			}
			ready, e := s.readinessWithin(ctx, tx, r, runtime)
			if e != nil {
				return nil, e
			}
			if ready["ready"] != true {
				return nil, fail("operations_autonomy_not_ready")
			}
			rows = append(rows, r)
		}
		accounts := []Object{}
		for _, old := range rows {
			if old["enabled"] == true {
				accounts = append(accounts, present(old))
				continue
			}
			cfg := obj(clone(old["configuration"]))
			cfg["enabled"] = true
			next, e := NextDue(obj(cfg["schedule"]), s.now())
			if e != nil {
				return nil, e
			}
			r, e := one(ctx, tx, `UPDATE operations_autonomy_configs_v1 SET revision=revision+1,enabled=true,configuration=$3,enabled_at=$4,next_due_at=$5,updated_by=$6,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_autonomy_configs_v1)`, s.Endpoint, old["id"], jsonText(cfg), s.now(), next, actor.ID)
			if e != nil {
				return nil, e
			}
			if e = s.versionWithin(ctx, tx, r, actor.ID); e != nil {
				return nil, e
			}
			accounts = append(accounts, present(r))
		}
		return s.recordWithin(ctx, tx, actor, str(x["operationId"]), "enable", x, Object{"operationId": x["operationId"], "accounts": accounts, "replayed": false})
	})
}
