package operationsstrategies

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) actor(ctx context.Context, tx pgx.Tx, a Actor, action string, authorize func() (Actor, error)) (Actor, error) {
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
	if s.Executor != nil && s.Executor.AcceptsExecutor(a) {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if authorize != nil && s.authorizeWithin == nil {
		fresh, e := authorize()
		if e != nil {
			return Actor{}, e
		}
		if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint || (fresh.AIProof != nil && !s.acceptsPreparation(fresh)) || s.domain().IsDuty(fresh) {
			return Actor{}, fail("business_admin_denied", 403)
		}
		a = fresh
	}
	if s.Authority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	if s.domain().IsDuty(a) {
		if action != "strategies.read" {
			return Actor{}, fail("business_admin_denied", 403)
		}
		return s.domain().Fresh(ctx, tx, a, action)
	}
	if a.AIProof != nil && !s.acceptsPreparation(a) {
		if action != "strategies.read" {
			return Actor{}, fail("business_admin_denied", 403)
		}
		if q, ok := s.Authority.(interface{ AcceptsQuery(Actor) bool }); !ok || !q.AcceptsQuery(a) {
			return Actor{}, fail("business_admin_denied", 403)
		}
	}
	return s.Authority.RequireWithin(ctx, tx, a, action)
}
func (s *Service) current(ctx context.Context, a Actor, action string) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, action, nil) })
}
func (s *Service) head(ctx context.Context, q Reader) (Object, error) {
	o, e := one(ctx, q, `SELECT to_jsonb(h) FROM operations_p13_strategy_heads_v1 h WHERE endpoint=$1`, s.Endpoint)
	if e == nil && o == nil {
		o = Object{"revision": 0, "active_id": nil, "draft_id": nil, "paused": true, "blocked_version_ids": []any{}}
	}
	return o, e
}
func (s *Service) version(ctx context.Context, q Reader, id any) (Object, error) {
	if id == nil {
		return nil, nil
	}
	return one(ctx, q, `SELECT to_jsonb(q) FROM(SELECT v.*,p.display_name AS created_by_display_name FROM operations_p13_strategy_versions_v1 v LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=v.endpoint AND p.operator_id=v.created_by WHERE v.endpoint=$1 AND v.id=$2)q`, s.Endpoint, id)
}
func (s *Service) lock(ctx context.Context, tx pgx.Tx, key string) error {
	if key == "" {
		key = "head"
	}
	_, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912437))`, s.Endpoint+":p13:"+key)
	return e
}
func (s *Service) event(ctx context.Context, tx Writer, kind string, values Object) error {
	metadata := values["metadata"]
	if metadata == nil {
		metadata = Object{}
	}
	_, e := tx.Exec(ctx, `INSERT INTO operations_p13_strategy_events_v1(id,endpoint,version_id,strategy_id,run_id,kind,operator_id,operation_id,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, uuid.NewString(), s.Endpoint, values["versionId"], values["strategyId"], values["runId"], kind, values["operatorId"], values["operationId"], metadata, s.now())
	return e
}
func VersionView(r Object) any {
	if r == nil {
		return nil
	}
	return Object{"id": r["id"], "version": r["version"], "configuration": r["configuration"], "createdBy": r["created_by"], "createdByDisplayName": r["created_by_display_name"], "createdAt": iso(r["created_at"]), "parentVersionId": r["parent_id"], "ordinaryStrategyId": r["ordinary_strategy_id"], "ordinaryExecutionId": r["ordinary_execution_id"]}
}
func actionFor(kind string) string {
	if kind == "draft" {
		return "strategies.configure"
	}
	if kind == "publish" {
		return "strategies.publish"
	}
	return "strategies.control"
}
func (s *Service) command(ctx context.Context, a Actor, kind string, x Object, authorize func() (Actor, error), operation func(pgx.Tx, Actor, Object) (Object, error)) (Object, error) {
	if authorize == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, actionFor(kind), authorize) }); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.lock(ctx, tx, ""); e != nil {
			return nil, e
		}
		if e := s.lock(ctx, tx, "operation:"+str(x["operationId"])); e != nil {
			return nil, e
		}
		actor, e := s.actor(ctx, tx, a, actionFor(kind), authorize)
		if e != nil {
			return nil, e
		}
		old, e := one(ctx, tx, `SELECT to_jsonb(c) FROM operations_p13_strategy_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, x["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if old["operator_id"] != actor.ID || old["kind"] != kind || !same(old["input"], x) {
				return nil, fail("p13_operation_conflict", 409)
			}
			r := clone(obj(old["result"]))
			r["replayed"] = true
			return r, nil
		}
		head, e := s.head(ctx, tx)
		if e != nil {
			return nil, e
		}
		if num(head["revision"]) != num(x["expectedRevision"]) {
			return nil, fail("p13_strategy_revision_changed", 409)
		}
		result, e := operation(tx, actor, head)
		if e != nil {
			return nil, e
		}
		if _, e = s.actor(ctx, tx, a, actionFor(kind), authorize); e != nil {
			return nil, e
		}
		versionID := result["versionId"]
		if versionID == nil {
			versionID = head["active_id"]
		}
		if e = s.domain().Record(ctx, tx, actor, actionFor(kind), Object{"versionId": versionID, "revision": head["revision"]}, Object{"version": result["version"], "revision": result["revision"]}, x["operationId"]); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_p13_strategy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, s.Endpoint, x["operationId"], actor.ID, kind, x, result, s.now()); e != nil {
			return nil, e
		}
		result["replayed"] = false
		return result, nil
	})
}
func (s *Service) SaveDraft(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseCommand("draft", input)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, a, "draft", x, authorize, func(tx pgx.Tx, actor Actor, head Object) (Object, error) {
		var version int64
		if e := tx.QueryRow(ctx, `SELECT coalesce(max(version),0)+1 FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1`, s.Endpoint).Scan(&version); e != nil {
			return nil, e
		}
		id := uuid.NewString()
		if _, e := tx.Exec(ctx, `INSERT INTO operations_p13_strategy_versions_v1(id,endpoint,version,configuration,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6)`, id, s.Endpoint, version, x["configuration"], actor.ID, s.now()); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `INSERT INTO operations_p13_strategy_heads_v1(endpoint,revision,draft_id,updated_at) VALUES($1,1,$2,$3) ON CONFLICT(endpoint) DO UPDATE SET revision=operations_p13_strategy_heads_v1.revision+1,draft_id=EXCLUDED.draft_id,updated_at=EXCLUDED.updated_at`, s.Endpoint, id, s.now()); e != nil {
			return nil, e
		}
		if e := s.event(ctx, tx, "draft", Object{"versionId": id, "operatorId": actor.ID, "operationId": x["operationId"], "metadata": Object{"version": version}}); e != nil {
			return nil, e
		}
		return Object{"operationId": x["operationId"], "versionId": id, "version": version, "revision": num(head["revision"]) + 1, "state": "saved"}, nil
	})
}
func (s *Service) Control(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseCommand("control", input)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, a, "control", x, authorize, func(tx pgx.Tx, actor Actor, head Object) (Object, error) {
		if head["active_id"] == nil {
			return nil, fail("p13_active_version_required", 409)
		}
		if x["kind"] == "resume" && has(texts(head["blocked_version_ids"]), str(head["active_id"])) {
			return nil, fail("p13_version_blocked", 409)
		}
		if _, e := tx.Exec(ctx, `UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,paused=$2,updated_at=$3 WHERE endpoint=$1`, s.Endpoint, x["kind"] == "pause", s.now()); e != nil {
			return nil, e
		}
		if e := s.event(ctx, tx, str(x["kind"]), Object{"versionId": head["active_id"], "operatorId": actor.ID, "operationId": x["operationId"]}); e != nil {
			return nil, e
		}
		state := "active-for-new-matters"
		if x["kind"] == "pause" {
			state = "paused"
		}
		return Object{"operationId": x["operationId"], "revision": num(head["revision"]) + 1, "state": state}, nil
	})
}
func Catalog() Object { var o Object; _ = json.Unmarshal([]byte(catalogJSON), &o); return o }
func (s *Service) nativeStatus(ctx context.Context) (Object, error) {
	if s.Native == nil {
		return Object{"state": "not-configured", "modelState": "not-configured", "framework": "agno", "version": "3.1.7", "workflow": WorkflowID}, nil
	}
	return s.Native.Status(ctx)
}
func (s *Service) Get(ctx context.Context, a Actor) (Object, error) {
	actor, e := s.current(ctx, a, "strategies.read")
	if e != nil {
		return nil, e
	}
	h, e := s.head(ctx, s.Pool)
	if e != nil {
		return nil, e
	}
	active, e := s.version(ctx, s.Pool, h["active_id"])
	if e != nil {
		return nil, e
	}
	draft, e := s.version(ctx, s.Pool, h["draft_id"])
	if e != nil {
		return nil, e
	}
	status, e := s.nativeStatus(ctx)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	configuration := active["configuration"]
	if configuration == nil {
		configuration = EmptyConfiguration()
	}
	return s.metadata(Object{"revision": h["revision"], "active": VersionView(active), "draft": VersionView(draft), "paused": h["paused"], "blockedVersionIds": h["blocked_version_ids"], "configuration": configuration, "catalog": Catalog(), "native": status, "capabilities": Object{"canConfigure": has(actor.Permissions, "strategies.configure"), "canPublish": has(actor.Permissions, "strategies.publish"), "canRun": has(actor.Permissions, "strategies.run") && status["state"] == "connected", "canControl": has(actor.Permissions, "strategies.control"), "canAiConfigure": false}}), nil
}
