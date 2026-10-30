package operationsmodels

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"sort"
)

func (s *Service) current(ctx context.Context, a Actor, action string) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.require(ctx, tx, a, action) })
}
func (s *Service) fresh(ctx context.Context, tx pgx.Tx, a Actor, action string, authorize func() (Actor, error)) (Actor, error) {
	if authorize == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	fresh, e := authorize()
	if e != nil {
		return Actor{}, e
	}
	if fresh.ID != a.ID || fresh.Endpoint != a.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if tx != nil {
		return s.require(ctx, tx, fresh, action)
	}
	return s.current(ctx, fresh, action)
}
func (s *Service) state(ctx context.Context, q Reader) (Object, error) {
	o, e := one(ctx, q, `SELECT to_jsonb(s) FROM operations_model_settings_state_v1 s WHERE endpoint=$1`, s.Endpoint)
	if e == nil && o == nil {
		o = Object{"revision": 0, "active_id": nil, "draft_id": nil, "pending_operation": nil}
	}
	return o, e
}
func (s *Service) version(ctx context.Context, q Reader, id any) (Object, error) {
	if id == nil {
		return nil, nil
	}
	return one(ctx, q, `SELECT to_jsonb(v) FROM operations_model_settings_versions_v1 v WHERE endpoint=$1 AND id=$2`, s.Endpoint, id)
}
func (s *Service) operation(ctx context.Context, q Reader, id any) (Object, error) {
	return one(ctx, q, `SELECT to_jsonb(o) FROM operations_model_settings_operations_v1 o WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
}
func (s *Service) lock(ctx context.Context, tx pgx.Tx) error {
	_, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,61243091))`, s.Endpoint)
	return e
}
func versionView(row Object) any {
	if row == nil {
		return nil
	}
	return Object{"id": row["id"], "version": row["version"], "configuration": row["configuration"], "operatorId": row["operator_id"], "createdAt": stamp(row["created_at"])}
}
func operationView(row Object, replayed bool) Object {
	return Object{"operationId": row["operation_id"], "kind": row["kind"], "phase": row["phase"], "versionId": row["version_id"], "modelRecordId": obj(row["input"])["modelRecordId"], "credentialRef": row["credential_ref"], "errorCode": row["error_code"], "replayed": replayed, "recordedAt": stamp(row["created_at"]), "updatedAt": stamp(row["updated_at"])}
}

var modelFields = []string{"displayName", "modelId", "apiFormat", "baseUrl", "credentialRef", "contextWindow", "maxOutputTokens", "reasoning", "timeoutSeconds", "toolCalling", "structuredOutput", "imageUnderstanding", "parallelToolCalls", "verbosity", "fallbacks", "contextCompression", "enabled"}

func ConfigurationChanges(before, after Object) Object {
	a, b := map[string]Object{}, map[string]Object{}
	ids := []string{}
	for _, v := range list(before["models"]) {
		r := obj(v)
		a[str(r["id"])] = r
		ids = append(ids, str(r["id"]))
	}
	for _, v := range list(after["models"]) {
		r := obj(v)
		id := str(r["id"])
		b[id] = r
		if a[id] == nil {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	models := []any{}
	for _, id := range ids {
		fields := []any{}
		for _, k := range modelFields {
			if !same(a[id][k], b[id][k]) {
				fields = append(fields, Object{"field": k, "before": a[id][k], "after": b[id][k]})
			}
		}
		if len(fields) > 0 {
			kind := "changed"
			if a[id] == nil {
				kind = "added"
			} else if b[id] == nil {
				kind = "removed"
			}
			models = append(models, Object{"id": id, "kind": kind, "fields": fields})
		}
	}
	scenarios := []any{}
	for _, d := range Domains {
		a, b := obj(before["scenarios"])[d], obj(after["scenarios"])[d]
		if !same(a, b) {
			scenarios = append(scenarios, Object{"domain": d, "before": a, "after": b})
		}
	}
	return Object{"models": models, "scenarios": scenarios}
}
func (s *Service) nativeStatus(ctx context.Context) (Object, error) {
	if s.Native == nil {
		return nil, fail("model_settings_native_not_configured", 503)
	}
	o, e := s.Native.Call(ctx, Object{"kind": "models-overview"})
	if e != nil {
		return nil, e
	}
	return ProjectStatus(o)
}
func (s *Service) record(ctx context.Context, tx pgx.Tx, a Actor, kind string, row, version Object) error {
	action := "models.configure"
	if kind == "apply" {
		action = "models.apply"
	}
	var count any
	if version != nil {
		count = len(list(obj(version["configuration"])["models"]))
	}
	return s.domain().Record(ctx, tx, a, action, Object{"version": version["version"], "kind": kind, "modelRecordId": obj(row["input"])["modelRecordId"]}, Object{"version": version["version"], "count": count}, row["operation_id"])
}
func (s *Service) prepare(ctx context.Context, a Actor, kind string, input Object, authorize func() (Actor, error)) (Object, bool, error) {
	action := "models.configure"
	if kind == "apply" {
		action = "models.apply"
	}
	if _, e := s.fresh(ctx, nil, a, action, authorize); e != nil {
		return nil, false, e
	}
	safe := input
	if kind == "credential-provision" {
		safe = Object{"operationId": input["operationId"], "modelRecordId": input["modelRecordId"]}
	}
	canonical, e := identity.Canonical(Object{"kind": kind, "input": safe})
	if e != nil {
		return nil, false, e
	}
	hash := identity.Digest(canonical)
	check := func(row Object) error {
		if row["operator_id"] != a.ID || row["kind"] != kind || row["request_hash"] != hash {
			return fail("model_settings_operation_conflict", 409)
		}
		return nil
	}
	old, e := s.operation(ctx, s.Pool, input["operationId"])
	if e != nil {
		return nil, false, e
	}
	if old != nil {
		return old, true, check(old)
	}
	var observed Object
	if kind == "apply" {
		observed, e = s.nativeStatus(ctx)
		if e != nil {
			return nil, false, e
		}
		if obj(observed["availability"])["state"] != "available" {
			return nil, false, fail("model_settings_native_unavailable", 503)
		}
		selected, e := s.version(ctx, s.Pool, input["versionId"])
		if e != nil {
			return nil, false, e
		}
		if selected == nil {
			return nil, false, fail("model_settings_version_unavailable", 404)
		}
		configuration, e := AssertApplicable(obj(selected["configuration"]))
		if e != nil {
			return nil, false, e
		}
		for _, v := range list(configuration["models"]) {
			m := obj(v)
			if m["enabled"] != true {
				continue
			}
			found := false
			for _, v := range list(observed["credentials"]) {
				c := obj(v)
				found = found || c["reference"] == m["credentialRef"] && c["modelRecordId"] == m["id"] && c["configured"] == true
			}
			if !found {
				return nil, false, fail("model_settings_credential_unavailable", 409)
			}
		}
	} else if kind == "credential-provision" && s.Native == nil {
		return nil, false, fail("model_settings_native_not_configured", 503)
	}
	replayed := false
	row, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.lock(ctx, tx); e != nil {
			return nil, e
		}
		actor, e := s.fresh(ctx, tx, a, action, authorize)
		if e != nil {
			return nil, e
		}
		prior, e := s.operation(ctx, tx, input["operationId"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			replayed = true
			return prior, check(prior)
		}
		state, e := s.state(ctx, tx)
		if e != nil {
			return nil, e
		}
		var version Object
		delta := Object{"models": []any{}, "scenarios": []any{}}
		if kind != "credential-provision" {
			if num(state["revision"]) != num(input["expectedRevision"]) {
				return nil, fail("model_settings_revision_changed", 409)
			}
			if state["pending_operation"] != nil {
				return nil, fail("model_settings_operation_pending", 409)
			}
			if _, e = tx.Exec(ctx, `INSERT INTO operations_model_settings_state_v1(endpoint,updated_at) VALUES($1,$2) ON CONFLICT DO NOTHING`, s.Endpoint, s.now()); e != nil {
				return nil, e
			}
			if kind == "draft" {
				var highest int
				if e = tx.QueryRow(ctx, `SELECT coalesce(max(version),0)::integer FROM operations_model_settings_versions_v1 WHERE endpoint=$1`, s.Endpoint).Scan(&highest); e != nil {
					return nil, e
				}
				version = Object{"id": uuid.NewString(), "version": highest + 1, "configuration": input["configuration"], "operator_id": actor.ID, "created_at": s.now()}
				priorID := state["draft_id"]
				if priorID == nil {
					priorID = state["active_id"]
				}
				previous, e := s.version(ctx, tx, priorID)
				if e != nil {
					return nil, e
				}
				before := obj(previous["configuration"])
				if before == nil {
					before = EmptyConfiguration()
				}
				delta = ConfigurationChanges(before, obj(version["configuration"]))
				_, e = tx.Exec(ctx, `INSERT INTO operations_model_settings_versions_v1(id,endpoint,version,configuration,operator_id,created_at) VALUES($1,$2,$3,$4,$5,$6)`, version["id"], s.Endpoint, version["version"], version["configuration"], actor.ID, s.now())
				if e != nil {
					return nil, e
				}
			} else {
				version, e = s.version(ctx, tx, input["versionId"])
				if e != nil {
					return nil, e
				}
				if version == nil || version["id"] != state["draft_id"] {
					return nil, fail("model_settings_draft_changed", 409)
				}
				if observed["appliedVersionId"] != state["active_id"] {
					return nil, fail("model_settings_native_drift", 409)
				}
				active, e := s.version(ctx, tx, state["active_id"])
				if e != nil {
					return nil, e
				}
				before := obj(active["configuration"])
				if before == nil {
					before = EmptyConfiguration()
				}
				delta = ConfigurationChanges(before, obj(version["configuration"]))
			}
		}
		phase := "prepared"
		if kind == "draft" {
			phase = "applied"
		}
		row, e := one(ctx, tx, `INSERT INTO operations_model_settings_operations_v1(endpoint,operation_id,operator_id,operator_role,kind,request_hash,input,version_id,phase,changes,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING to_jsonb(operations_model_settings_operations_v1)`, s.Endpoint, input["operationId"], actor.ID, actor.Role, kind, hash, safe, version["id"], phase, delta, input["reason"], s.now())
		if e != nil {
			return nil, e
		}
		if kind != "credential-provision" {
			draft, pending := state["draft_id"], any(nil)
			if kind == "draft" {
				draft = version["id"]
			} else {
				pending = input["operationId"]
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_model_settings_state_v1 SET revision=revision+1,draft_id=$2,pending_operation=$3,updated_at=$4 WHERE endpoint=$1`, s.Endpoint, draft, pending, s.now()); e != nil {
				return nil, e
			}
		}
		if _, e = s.fresh(ctx, tx, a, action, authorize); e != nil {
			return nil, e
		}
		if e = s.record(ctx, tx, actor, kind, row, version); e != nil {
			return nil, e
		}
		return row, nil
	})
	return row, replayed, e
}
