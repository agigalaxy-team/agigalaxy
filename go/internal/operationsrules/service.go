package operationsrules

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) actor(ctx context.Context, tx pgx.Tx, a Actor, write bool, authorize func() (Actor, error)) (Actor, error) {
	if s.authorizeWithin != nil {
		fresh, e := s.authorizeWithin(ctx, tx, a)
		if e != nil {
			return Actor{}, e
		}
		if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint {
			return Actor{}, fail("business_admin_denied", 403)
		}
		a = fresh
	}
	if s.Authority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	if authorize != nil && s.authorizeWithin == nil {
		fresh, e := authorize()
		if e != nil {
			return Actor{}, e
		}
		if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint || (fresh.AIProof != nil && !s.acceptsPreparation(fresh)) {
			return Actor{}, fail("business_admin_denied", 403)
		}
		a = fresh
	}
	if write {
		if authorize == nil {
			return Actor{}, fail("operations_authorization_unavailable", 503)
		}
		if (a.AIProof != nil && !s.acceptsPreparation(a)) || s.domain().IsDuty(a) || s.domain().IsExecution(a) {
			return Actor{}, fail("business_admin_denied", 403)
		}
	}
	action := "rules.read"
	if write {
		action = "rules.write"
	}
	return s.Authority.RequireWithin(ctx, tx, a, action)
}
func (s *Service) readable(ctx context.Context, a Actor) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, false, nil) })
}
func (s *Service) lock(ctx context.Context, tx pgx.Tx, key string) error {
	_, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.Endpoint+":p14-rules:"+key)
	return e
}
func (s *Service) CurrentWithin(ctx context.Context, q Reader, key string) (Object, error) {
	return one(ctx, q, `SELECT to_jsonb(r) FROM operations_product_rules_v1 r WHERE endpoint=$1 AND policy_key=$2 ORDER BY version DESC LIMIT 1`, s.Endpoint, key)
}
func (s *Service) head(ctx context.Context, q Reader, key string) (Object, error) {
	o, e := one(ctx, q, `SELECT to_jsonb(h) FROM operations_p14_rule_heads_v1 h WHERE endpoint=$1 AND policy_key=$2`, s.Endpoint, key)
	if e == nil && o == nil {
		return nil, fail("operations_policy_not_initialized", 503)
	}
	return o, e
}
func (s *Service) version(ctx context.Context, q Reader, key string, id any) (Object, error) {
	if id == nil {
		return nil, nil
	}
	return one(ctx, q, `SELECT to_jsonb(v) FROM operations_p14_rule_versions_v1 v WHERE endpoint=$1 AND policy_key=$2 AND id=$3`, s.Endpoint, key, id)
}
func (s *Service) addVersion(ctx context.Context, tx pgx.Tx, key string, policy Object, actor, source string, restored, published, created any) (Object, error) {
	var version int64
	if e := tx.QueryRow(ctx, `SELECT coalesce(max(version),0)+1 FROM operations_p14_rule_versions_v1 WHERE endpoint=$1 AND policy_key=$2`, s.Endpoint, key).Scan(&version); e != nil {
		return nil, e
	}
	var owner any
	if actor != "" {
		owner = actor
	}
	return one(ctx, tx, `INSERT INTO operations_p14_rule_versions_v1 AS v(id,endpoint,policy_key,version,policy,source,created_by,created_at,restored_from,published_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING to_jsonb(v)`, uuid.NewString(), s.Endpoint, key, version, policy, source, owner, created, restored, published)
}
func (s *Service) Bootstrap(ctx context.Context, actual map[string]Object) error {
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		for _, key := range Keys[:3] {
			input, exists := actual[key]
			if !exists {
				continue
			}
			policy, e := ParsePolicy(key, input)
			if e != nil {
				return false, e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,$2,1,$3,'configured-baseline',$4) ON CONFLICT DO NOTHING`, s.Endpoint, key, policy, s.now()); e != nil {
				return false, e
			}
		}
		for key := range actual {
			if !has(Keys[:3], key) {
				return false, invalid()
			}
		}
		return true, nil
	})
	return e
}
func (s *Service) Initialize(ctx context.Context) error {
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		for _, key := range Keys {
			if e := s.lock(ctx, tx, key); e != nil {
				return false, e
			}
			exists, e := one(ctx, tx, `SELECT to_jsonb(h) FROM operations_p14_rule_heads_v1 h WHERE endpoint=$1 AND policy_key=$2`, s.Endpoint, key)
			if e != nil {
				return false, e
			}
			if exists != nil {
				continue
			}
			if key == "business-controls" {
				if _, e = tx.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,$2,1,$3,'configured-baseline',$4) ON CONFLICT DO NOTHING`, s.Endpoint, key, EmptyControls(), s.now()); e != nil {
					return false, e
				}
			}
			rows, e := tx.Query(ctx, `SELECT to_jsonb(r) FROM operations_product_rules_v1 r WHERE endpoint=$1 AND policy_key=$2 ORDER BY version`, s.Endpoint, key)
			if e != nil {
				return false, e
			}
			previous, e := collect(rows)
			if e != nil {
				return false, e
			}
			if len(previous) == 0 {
				return false, fail("operations_policy_not_initialized", 503)
			}
			var active Object
			for _, r := range previous {
				policy, e := ParsePolicy(key, obj(r["policy"]))
				if e != nil {
					return false, e
				}
				active, e = s.addVersion(ctx, tx, key, policy, str(r["created_by"]), str(r["source"]), nil, r["version"], r["created_at"])
				if e != nil {
					return false, e
				}
			}
			if _, e = tx.Exec(ctx, `INSERT INTO operations_p14_rule_heads_v1(endpoint,policy_key,revision,active_id,updated_at) VALUES($1,$2,0,$3,$4)`, s.Endpoint, key, active["id"], s.now()); e != nil {
				return false, e
			}
		}
		return true, nil
	})
	return e
}
func changes(before, after Object) Object {
	out := Object{}
	for key, v := range before {
		if !same(v, after[key]) {
			out[key] = Object{"before": v, "after": after[key]}
		}
	}
	for key, v := range after {
		if _, exists := before[key]; !exists && !same(nil, v) {
			out[key] = Object{"before": nil, "after": v}
		}
	}
	return out
}
func (s *Service) validateAccounts(ctx context.Context, tx pgx.Tx, key string, policy Object) error {
	if key != "business-controls" {
		return nil
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, r := range list(policy["rules"]) {
		for _, e := range list(obj(r)["exceptions"]) {
			for _, id := range list(obj(e)["accountIds"]) {
				if !seen[str(id)] {
					seen[str(id)] = true
					ids = append(ids, str(id))
				}
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	var count int64
	if e := tx.QueryRow(ctx, `SELECT count(*) FROM community_accounts WHERE endpoint=$1 AND id=ANY($2::uuid[])`, s.Endpoint, ids).Scan(&count); e != nil {
		return e
	}
	if count != int64(len(ids)) {
		return fail("operations_rule_exception_account_unavailable", 409)
	}
	return nil
}
func (s *Service) command(ctx context.Context, a Actor, key, kind string, input Object, authorize func() (Actor, error)) (Object, error) {
	if !has(Keys, key) {
		return nil, invalid()
	}
	x, e := parseCommand(kind, input)
	if e != nil {
		return nil, e
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, true, authorize) }); e != nil {
		return nil, e
	}
	receipt, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.actor(ctx, tx, a, true, authorize)
		if e != nil {
			return nil, e
		}
		if e = s.lock(ctx, tx, key); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.Endpoint+":p14-operation:"+str(x["operationId"])); e != nil {
			return nil, e
		}
		old, e := one(ctx, tx, `SELECT to_jsonb(c) FROM operations_p14_rule_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, x["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if old["operator_id"] != actor.ID || old["policy_key"] != key || old["kind"] != kind || !same(old["input"], x) {
				return nil, fail("operations_command_changed", 409)
			}
			out := clone(obj(old["result"]))
			out["replayed"] = true
			return out, nil
		}
		h, e := s.head(ctx, tx, key)
		if e != nil {
			return nil, e
		}
		active, e := s.version(ctx, tx, key, h["active_id"])
		if e != nil {
			return nil, e
		}
		if num(h["revision"]) != num(x["expectedRevision"]) {
			return nil, fail("operations_rule_revision_changed", 409)
		}
		var target, policy Object
		if kind == "draft" {
			policy, e = ParsePolicy(key, obj(x["policy"]))
		} else {
			target, e = s.version(ctx, tx, key, x["versionId"])
			if e == nil && target == nil {
				return nil, fail("operations_rule_version_unavailable", 404)
			}
			if e == nil {
				if kind == "publish" && h["draft_id"] != target["id"] {
					return nil, fail("operations_rule_draft_changed", 409)
				}
				if kind == "restore" && target["published_version"] == nil {
					return nil, fail("operations_rule_version_not_published", 409)
				}
				policy, e = ParsePolicy(key, obj(target["policy"]))
			}
		}
		if e != nil {
			return nil, e
		}
		if e = s.validateAccounts(ctx, tx, key, policy); e != nil {
			return nil, e
		}
		var published any
		if kind != "draft" {
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, s.Endpoint+":operations-rule:"+key); e != nil {
				return nil, e
			}
			actual, e := s.CurrentWithin(ctx, tx, key)
			if e != nil {
				return nil, e
			}
			if actual == nil || !same(actual["version"], active["published_version"]) {
				return nil, fail("operations_rule_source_changed", 409)
			}
			published = num(actual["version"]) + 1
			if _, e = tx.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,created_by,source,created_at) VALUES($1,$2,$3,$4,$5,'business-operator',$6)`, s.Endpoint, key, published, policy, actor.ID, s.now()); e != nil {
				return nil, e
			}
		}
		source := "business-operator"
		var restored any
		if kind == "restore" {
			source = "restore"
			restored = target["id"]
		}
		v, e := s.addVersion(ctx, tx, key, policy, actor.ID, source, restored, published, s.now())
		if e != nil {
			return nil, e
		}
		activeID, draftID := h["active_id"], any(nil)
		if kind == "draft" {
			draftID = v["id"]
		} else {
			activeID = v["id"]
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_p14_rule_heads_v1 SET revision=revision+1,active_id=$3,draft_id=$4,updated_at=$5 WHERE endpoint=$1 AND policy_key=$2`, s.Endpoint, key, activeID, draftID, s.now()); e != nil {
			return nil, e
		}
		before := obj(active["policy"])
		if kind == "draft" && h["draft_id"] != nil {
			d, e := s.version(ctx, tx, key, h["draft_id"])
			if e != nil {
				return nil, e
			}
			before = obj(d["policy"])
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_p14_rule_events_v1(id,endpoint,policy_key,operation_id,version_id,kind,operator_id,reason,changes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, uuid.NewString(), s.Endpoint, key, x["operationId"], v["id"], kind, actor.ID, x["reason"], changes(before, policy), s.now()); e != nil {
			return nil, e
		}
		result := Object{"operationId": x["operationId"], "kind": kind, "key": key, "versionId": v["id"], "version": v["version"], "publishedVersion": published, "revision": num(h["revision"]) + 1, "recordedAt": iso(s.now())}
		auditVersion := published
		if auditVersion == nil {
			auditVersion = active["published_version"]
		}
		if e = s.domain().Record(ctx, tx, actor, "rule-save", Object{"key": key, "expectedVersion": active["published_version"]}, Object{"version": auditVersion}, x["operationId"]); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_p14_rule_commands_v1(endpoint,operation_id,operator_id,policy_key,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, s.Endpoint, x["operationId"], actor.ID, key, kind, x, result, s.now()); e != nil {
			return nil, e
		}
		if _, e = s.actor(ctx, tx, a, true, authorize); e != nil {
			return nil, e
		}
		result["replayed"] = false
		return result, nil
	})
	if e != nil {
		return nil, e
	}
	detail, e := s.Get(ctx, a, key)
	if e != nil {
		return nil, e
	}
	receipt["detail"] = detail
	return receipt, nil
}
func (s *Service) SaveDraft(ctx context.Context, a Actor, key string, x Object, authorize func() (Actor, error)) (Object, error) {
	return s.command(ctx, a, key, "draft", x, authorize)
}
func (s *Service) Publish(ctx context.Context, a Actor, key string, x Object, authorize func() (Actor, error)) (Object, error) {
	return s.command(ctx, a, key, "publish", x, authorize)
}
func (s *Service) Restore(ctx context.Context, a Actor, key string, x Object, authorize func() (Actor, error)) (Object, error) {
	return s.command(ctx, a, key, "restore", x, authorize)
}
