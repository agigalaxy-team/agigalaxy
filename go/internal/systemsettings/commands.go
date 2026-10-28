package systemsettings

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var actions = map[string]string{"read": "system.settings.read", "save": "system.settings.configure", "test": "system.settings.test", "apply": "system.settings.apply", "credential": "system.settings.credentials.write"}
var auditActions = map[string]string{"save": "system-settings-save", "test": "system-settings-test", "apply": "system-settings-apply", "credential": "system-settings-credential-provision"}

type prepared struct {
	row, version Object
	replayed     bool
}
type reconciliation struct {
	done chan struct{}
	row  Object
	err  error
}

func pendingState(r Object) bool { return r["state"] == "accepted" || r["state"] == "unknown" }
func (s *Service) record(ctx context.Context, tx pgx.Tx, a Actor, row Object) error {
	selection := Object{"section": row["section"], "kind": row["kind"], "versionId": row["version_id"], "revision": row["revision"]}
	result := Object{"state": row["state"], "versionId": row["version_id"], "revision": row["revision"]}
	_, e := tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,http_request_id,selection,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, uuid.NewString(), s.Endpoint, a.ID, a.Role, auditActions[str(row["kind"])], row["operation_id"], a.RequestID, selection, result, s.now())
	return e
}
func (s *Service) prepare(ctx context.Context, a Actor, section, kind string, input Object, authorize func() (Actor, error)) (prepared, error) {
	if !includes(sections, section) {
		return prepared{}, invalid()
	}
	if _, e := s.freshOutside(ctx, a, actions[kind], authorize); e != nil {
		return prepared{}, e
	}
	safeInput := input
	if kind == "credential" {
		safeInput = CredentialMetadata(input)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (prepared, error) {
		if e := s.operationLock(ctx, tx, str(input["operationId"])); e != nil {
			return prepared{}, e
		}
		if e := s.lock(ctx, tx, section); e != nil {
			return prepared{}, e
		}
		actor, e := s.fresh(ctx, tx, a, actions[kind], authorize)
		if e != nil {
			return prepared{}, e
		}
		prior, e := s.row(ctx, tx, str(input["operationId"]))
		if e != nil {
			return prepared{}, e
		}
		if prior != nil {
			if prior["operator_id"] != actor.ID || prior["section"] != section || prior["kind"] != kind || !same(prior["input"], safeInput) {
				return prepared{}, fail("system_settings_operation_changed", 409)
			}
			return prepared{row: prior, replayed: true}, nil
		}
		head, e := s.head(ctx, tx, section)
		if e != nil {
			return prepared{}, e
		}
		if num(head["revision"]) != num(input["expectedRevision"]) {
			return prepared{}, fail("system_settings_version_changed", 409)
		}
		if head["pending_operation"] != nil && kind != "credential" {
			return prepared{}, fail("system_settings_native_busy", 409)
		}
		var version Object
		if kind == "save" {
			configuration, e := ParseConfiguration(section, obj(input["configuration"]))
			if e != nil {
				return prepared{}, e
			}
			version, e = one(ctx, tx, `INSERT INTO operations_system_settings_versions_v1(id,endpoint,section,revision,configuration,operator_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING to_jsonb(operations_system_settings_versions_v1)`, uuid.NewString(), s.Endpoint, section, num(head["revision"])+1, configuration, actor.ID, s.now())
			if e != nil {
				return prepared{}, e
			}
		} else if kind != "credential" {
			version, e = s.version(ctx, tx, input["versionId"], section)
			if e != nil {
				return prepared{}, e
			}
			if version == nil || head["version_id"] != version["id"] {
				return prepared{}, fail("system_settings_version_changed", 409)
			}
			if kind == "test" && input["connectionId"] != nil {
				exists := false
				for _, v := range list(obj(version["configuration"])["connections"]) {
					exists = exists || obj(v)["id"] == input["connectionId"]
				}
				if !exists {
					return prepared{}, invalid()
				}
			}
			if e = AssertEffectConfiguration(section, obj(version["configuration"]), kind, str(input["connectionId"])); e != nil {
				return prepared{}, e
			}
		}
		var versionID any
		revision := head["revision"]
		if version != nil {
			versionID, revision = version["id"], version["revision"]
		}
		state := "accepted"
		if kind == "save" {
			state = "completed"
		}
		row, e := one(ctx, tx, `INSERT INTO operations_system_settings_commands_v1(endpoint,operation_id,operator_id,operator_role,section,kind,input,version_id,revision,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING to_jsonb(operations_system_settings_commands_v1)`, s.Endpoint, input["operationId"], actor.ID, actor.Role, section, kind, safeInput, versionID, revision, state, Object{"phases": []any{}}, s.now())
		if e != nil {
			return prepared{}, e
		}
		if kind == "save" {
			_, e = tx.Exec(ctx, `INSERT INTO operations_system_settings_heads_v1(endpoint,section,revision,version_id,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(endpoint,section) DO UPDATE SET revision=EXCLUDED.revision,version_id=EXCLUDED.version_id,updated_at=EXCLUDED.updated_at`, s.Endpoint, section, revision, versionID, s.now())
		} else if kind == "apply" {
			_, e = tx.Exec(ctx, `UPDATE operations_system_settings_heads_v1 SET pending_operation=$3,updated_at=$4 WHERE endpoint=$1 AND section=$2`, s.Endpoint, section, row["operation_id"], s.now())
		}
		if e != nil {
			return prepared{}, e
		}
		if _, e = s.fresh(ctx, tx, a, actions[kind], authorize); e != nil {
			return prepared{}, e
		}
		if e = s.record(ctx, tx, actor, row); e != nil {
			return prepared{}, e
		}
		return prepared{row: row, version: version}, nil
	})
}
func (s *Service) nativeIntent(ctx context.Context, row, input Object) (Object, error) {
	if row["kind"] == "credential" {
		intent := clone(obj(row["input"]))
		intent["kind"], intent["operatorId"], intent["credential"] = "settings-credential-provision", row["operator_id"], input["credential"]
		return intent, nil
	}
	version, e := s.version(ctx, s.Pool, row["version_id"], str(row["section"]))
	if e != nil {
		return nil, e
	}
	kind := "settings-apply"
	if row["kind"] == "test" {
		kind = "settings-test"
	}
	intent := Object{"kind": kind, "operationId": row["operation_id"], "operatorId": row["operator_id"], "section": row["section"], "revision": row["revision"], "versionId": row["version_id"], "configuration": version["configuration"]}
	if id := str(obj(row["input"])["connectionId"]); id != "" {
		intent["connectionId"] = id
	}
	return intent, nil
}
func (s *Service) acceptNative(ctx context.Context, row, input Object) (Object, error) {
	if value := obj(input["operation"]); value != nil {
		input = value
	}
	value, e := ParseOperation(input)
	if e != nil {
		return nil, e
	}
	if value["operationId"] != row["operation_id"] || value["section"] != row["section"] || value["kind"] != row["kind"] || value["versionId"] != row["version_id"] || num(value["revision"]) != num(row["revision"]) || row["kind"] == "credential" && value["state"] == "completed" && value["credentialRef"] != "system-key:"+str(row["operation_id"]) {
		return nil, fail("system_settings_native_response_invalid", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.operationLock(ctx, tx, str(row["operation_id"])); e != nil {
			return nil, e
		}
		if e := s.lock(ctx, tx, str(row["section"])); e != nil {
			return nil, e
		}
		current, e := s.row(ctx, tx, str(row["operation_id"]))
		if e != nil || current == nil || !pendingState(current) {
			return current, e
		}
		result := clone(obj(current["result"]))
		result["phases"] = value["phases"]
		if value["credentialRef"] != nil {
			result["credentialRef"] = value["credentialRef"]
		}
		saved, e := one(ctx, tx, `UPDATE operations_system_settings_commands_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2 RETURNING to_jsonb(operations_system_settings_commands_v1)`, s.Endpoint, row["operation_id"], value["state"], result, s.now())
		if e != nil {
			return nil, e
		}
		if row["kind"] == "apply" && includes([]string{"completed", "partial", "failed"}, str(value["state"])) {
			_, e = tx.Exec(ctx, `UPDATE operations_system_settings_heads_v1 SET pending_operation=NULL,updated_at=$4 WHERE endpoint=$1 AND section=$2 AND pending_operation=$3`, s.Endpoint, row["section"], row["operation_id"], s.now())
		}
		return saved, e
	})
}
func (s *Service) unknown(ctx context.Context, row Object, cause error) (Object, error) {
	target := "control"
	if row["kind"] == "credential" {
		target = "credential"
	}
	result := Object{"phases": []any{Object{"target": target, "state": "unknown", "code": safeError(cause, "system_settings_native_unavailable"), "adoptedVersionId": nil}}}
	saved, e := optional(ctx, s.Pool, `UPDATE operations_system_settings_commands_v1 SET state='unknown',result=result||$3::jsonb,updated_at=$4 WHERE endpoint=$1 AND operation_id=$2 AND state IN ('accepted','unknown') RETURNING to_jsonb(operations_system_settings_commands_v1)`, s.Endpoint, row["operation_id"], result, s.now())
	if e != nil || saved != nil {
		return saved, e
	}
	return s.row(ctx, s.Pool, str(row["operation_id"]))
}
func (s *Service) reconcile(ctx context.Context, id, owner string) (Object, error) {
	s.reconcileMu.Lock()
	if old := s.reconciling[id]; old != nil {
		s.reconcileMu.Unlock()
		select {
		case <-old.done:
			return old.row, old.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if s.reconciling == nil {
		s.reconciling = map[string]*reconciliation{}
	}
	pending := &reconciliation{done: make(chan struct{})}
	s.reconciling[id] = pending
	s.reconcileMu.Unlock()
	row, e := func() (Object, error) {
		row, e := s.row(ctx, s.Pool, id)
		if e != nil || row == nil || row["operator_id"] != owner || !pendingState(row) || s.Native == nil {
			return row, e
		}
		value, e := s.Native.Call(ctx, Object{"kind": "settings-operation", "operationId": id, "operatorId": owner, "section": row["section"]})
		if e != nil {
			return s.unknown(ctx, row, e)
		}
		if value["state"] == "not-recorded" {
			return s.unknown(ctx, row, fail("system_settings_operation_unknown", 409))
		}
		saved, e := s.acceptNative(ctx, row, value)
		if e != nil {
			return s.unknown(ctx, row, e)
		}
		return saved, nil
	}()
	s.reconcileMu.Lock()
	pending.row, pending.err = row, e
	close(pending.done)
	delete(s.reconciling, id)
	s.reconcileMu.Unlock()
	return row, e
}
func (s *Service) Command(ctx context.Context, a Actor, section, kind string, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseCommand(kind, input)
	if e != nil {
		return nil, e
	}
	if kind == "credential" && x["section"] != section {
		return nil, invalid()
	}
	if kind == "save" {
		configuration, e := ParseConfiguration(section, obj(x["configuration"]))
		if e != nil {
			return nil, e
		}
		x["configuration"] = configuration
	}
	if kind != "save" && s.Native == nil {
		return nil, fail("system_settings_native_not_configured", 503)
	}
	p, e := s.prepare(ctx, a, section, kind, x, authorize)
	if e != nil {
		return nil, e
	}
	row := p.row
	if kind != "save" && !p.replayed {
		if _, e = s.freshOutside(ctx, a, actions[kind], authorize); e == nil {
			var intent Object
			intent, e = s.nativeIntent(ctx, row, x)
			if e == nil {
				var value Object
				value, e = s.Native.Call(ctx, intent)
				if e == nil {
					row, e = s.acceptNative(ctx, row, value)
				}
			}
		}
		if e != nil {
			row, e = s.unknown(ctx, p.row, e)
			if e != nil {
				return nil, e
			}
		}
	} else if pendingState(row) {
		row, e = s.reconcile(ctx, str(row["operation_id"]), a.ID)
		if e != nil {
			return nil, e
		}
	}
	if _, e = s.freshOutside(ctx, a, actions[kind], authorize); e != nil {
		return nil, e
	}
	view, e := OperationView(row)
	if e != nil {
		return nil, e
	}
	result := Object{"operation": view, "replayed": p.replayed}
	if kind == "save" {
		version := p.version
		if version == nil {
			version, e = s.version(ctx, s.Pool, row["version_id"], section)
			if e != nil {
				return nil, e
			}
		}
		result["version"] = VersionView(version)
	}
	return s.stamp(result), nil
}
