package managementaccounts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Authorize func(context.Context) (Actor, error)

func jsonText(v any) string { b, _ := protocol.EncodeJS(v); return string(b) }
func same(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func (s *Service) current(ctx context.Context, tx pgx.Tx, original Actor, action string, authorize Authorize) (Actor, error) {
	if authorize == nil {
		return Actor{}, nativeError("operations_authorization_unavailable")
	}
	fresh, e := authorize(ctx)
	if e != nil {
		return Actor{}, e
	}
	if fresh.ID != original.ID || fresh.Endpoint != s.Endpoint || fresh.AIProof != nil {
		return Actor{}, fault.New("business_admin_denied", 403)
	}
	check := func(tx pgx.Tx) (Actor, error) {
		if _, e := s.actor(ctx, tx, fresh, "management.accounts.read"); e != nil {
			return Actor{}, e
		}
		return s.actor(ctx, tx, fresh, action)
	}
	if tx != nil {
		return check(tx)
	}
	return postgres.InTx(ctx, s.Pool, check)
}
func (s *Service) guard(a Actor, u *User, kind string) error {
	if s.Root == nil {
		return nativeError("operations_authorization_unavailable")
	}
	root, self := s.rootTarget(u.Issuer, u.ExternalSubject), a.ID == ID(u.Issuer, u.ExternalSubject)
	if root && (!self || !s.rootActor(a) || includes([]string{"login-disable", "login-restore", "delete", "admission-change", "assignment"}, kind)) {
		return fault.New("management_root_protected", 403)
	}
	if kind == "admission-change" && !s.rootActor(a) {
		return fault.New("management_root_only", 403)
	}
	if self && (kind == "login-disable" || kind == "delete") {
		return fault.New("management_self_protected", 403)
	}
	return nil
}
func (s *Service) principalWithin(ctx context.Context, tx pgx.Tx, u *User, a Actor, note string) (Object, error) {
	id := ID(u.Issuer, u.ExternalSubject)
	old, e := optionalObject(ctx, tx, `SELECT to_jsonb(p) FROM operations_operator_principals_v1 p WHERE operator_id=$1`, id)
	if e != nil {
		return nil, e
	}
	if old != nil && (old["endpoint"] != s.Endpoint || old["issuer"] != u.Issuer || old["external_subject"] != u.ExternalSubject) {
		return nil, fault.New("management_identity_target_changed", 409)
	}
	at := s.now()
	if _, e = tx.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(operator_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=EXCLUDED.updated_at`, id, s.Endpoint, u.Issuer, u.ExternalSubject, display(u), at); e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO operations_management_accounts_v1(operator_id,endpoint,issuer,external_subject,version,note,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$7) ON CONFLICT(operator_id) DO NOTHING`, id, s.Endpoint, u.Issuer, u.ExternalSubject, note, a.ID, at); e != nil {
		return nil, e
	}
	return readObject(ctx, tx, `SELECT to_jsonb(m) FROM operations_management_accounts_v1 m WHERE endpoint=$1 AND operator_id=$2`, s.Endpoint, id)
}

type claim struct {
	old, row, meta Object
	actor          Actor
}

func (s *Service) reserve(ctx context.Context, original Actor, kind string, x Object, targetID *string, u *User, action string, authorize Authorize) (claim, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (claim, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912462))`, jsonText([]any{s.Endpoint, x["operationId"]})); e != nil {
			return claim{}, e
		}
		a, e := s.current(ctx, tx, original, action, authorize)
		if e != nil {
			return claim{}, e
		}
		intent := Intent(x)
		old, e := optionalObject(ctx, tx, `SELECT to_jsonb(c) FROM operations_management_commands_v1 c WHERE operation_id=$1`, x["operationId"])
		if e != nil {
			return claim{}, e
		}
		if old != nil {
			var target any
			if targetID != nil {
				target = *targetID
			}
			if old["endpoint"] != s.Endpoint || old["operator_id"] != a.ID || (old["target_operator_id"] != target && kind != "create") || old["kind"] != kind || !same(old["input"], intent) {
				return claim{}, fault.New("management_operation_conflict", 409)
			}
			return claim{old: old}, nil
		}
		var target any
		var key string
		if targetID != nil {
			target = *targetID
			key = *targetID
		} else {
			key = strings.ToLower(str(x["username"]))
		}
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912463))`, jsonText([]any{s.Endpoint, key})); e != nil {
			return claim{}, e
		}
		pendingSQL := `SELECT EXISTS(SELECT 1 FROM operations_management_commands_v1 WHERE endpoint=$1 AND state IN('accepted','unknown') AND target_operator_id=$2)`
		if targetID == nil {
			pendingSQL = `SELECT EXISTS(SELECT 1 FROM operations_management_commands_v1 WHERE endpoint=$1 AND state IN('accepted','unknown') AND kind='create' AND lower(input->>'username')=$2)`
		}
		var pending bool
		if e := tx.QueryRow(ctx, pendingSQL, s.Endpoint, key).Scan(&pending); e != nil {
			return claim{}, e
		}
		if pending {
			return claim{}, fault.New("management_operation_pending", 409)
		}
		var meta Object
		if kind == "create" {
			if s.Root == nil || s.Directory == nil || !s.Directory.ManagementConfigured() {
				return claim{}, nativeError("management_writer_not_configured")
			}
			for _, id := range stringList(x["roleIds"]) {
				r, e := optionalObject(ctx, tx, `SELECT to_jsonb(r) FROM operations_business_roles_v1 r WHERE endpoint=$1 AND id=$2`, s.Endpoint, id)
				if e != nil {
					return claim{}, e
				}
				if r["enabled"] != true {
					return claim{}, fault.New("operations_permissions_target_changed", 409)
				}
				if !has(a, "permissions.assignments.write") {
					return claim{}, fault.New("operations_permission_denied", 403)
				}
				for _, c := range stringList(r["permissions"]) {
					if !has(a, c) {
						return claim{}, fault.New("operations_permission_denied", 403)
					}
				}
			}
		} else {
			row, e := s.targetWithin(ctx, tx, *targetID)
			if e != nil {
				return claim{}, e
			}
			if row["deleted_at"] != nil || u == nil {
				return claim{}, fault.New("management_identity_not_found", 404)
			}
			if e := s.guard(a, u, kind); e != nil {
				return claim{}, e
			}
			version, e := TargetVersion(u, row)
			if e != nil {
				return claim{}, e
			}
			if version != x["expectedVersion"] {
				return claim{}, fault.New("management_identity_target_changed", 409)
			}
			if s.Directory == nil || !s.Directory.ManagementConfigured() {
				return claim{}, nativeError("management_writer_not_configured")
			}
			if kind == "email-change" && !s.Directory.EmailChangeConfigured() {
				return claim{}, nativeError("management_email_verification_not_configured")
			}
			if kind == "login-disable" && (!u.Enabled || row["login_blocked"] == true) || kind == "login-restore" && u.Enabled && row["login_blocked"] != true {
				return claim{}, fault.New("management_identity_target_changed", 409)
			}
			if kind == "admission-change" && (x["action"] == "promote" && u.Admission == "administrator" || x["action"] != "promote" && u.Admission != "administrator") {
				return claim{}, fault.New("management_identity_target_changed", 409)
			}
			meta, e = s.principalWithin(ctx, tx, u, a, "")
			if e != nil {
				return claim{}, e
			}
		}
		row, e := readObject(ctx, tx, `INSERT INTO operations_management_commands_v1(operation_id,endpoint,operator_id,target_operator_id,kind,state,input,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8,$8) RETURNING to_jsonb(operations_management_commands_v1)`, x["operationId"], s.Endpoint, a.ID, target, kind, jsonText(intent), jsonText(Object{"phases": []any{}, "revision": meta["version"]}), s.now())
		return claim{row: row, meta: meta, actor: a}, e
	})
}
func stateOf(phases []Object) string {
	confirmed, accepted, unknown := false, false, false
	all := true
	for _, p := range phases {
		unknown = unknown || p["state"] == "unknown"
		accepted = accepted || p["state"] == "accepted"
		ok := p["state"] == "confirmed" || p["state"] == "submitted"
		confirmed = confirmed || ok
		all = all && ok
	}
	if unknown {
		return "unknown"
	}
	if accepted {
		return "accepted"
	}
	if all {
		return "completed"
	}
	if confirmed {
		return "partial"
	}
	return "failed"
}
func phase(kind, state string, code any) Object {
	return Object{"kind": kind, "state": state, "code": code}
}
func (s *Service) update(ctx context.Context, row Object, phases []Object, target any, revision any, binding Object) (Object, error) {
	result := Object{"phases": phases, "revision": revision}
	old, _ := row["result"].(map[string]any)
	if binding != nil {
		result["binding"] = binding
	} else if old["binding"] != nil {
		result["binding"] = old["binding"]
	}
	return readObject(ctx, s.Pool, `UPDATE operations_management_commands_v1 SET target_operator_id=$3,state='accepted',result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2 RETURNING to_jsonb(operations_management_commands_v1)`, s.Endpoint, row["operation_id"], target, jsonText(result), s.now())
}
func (s *Service) invoke(ctx context.Context, row *Object, phases *[]Object, kind string, run func() (Object, error)) (Object, error) {
	*phases = append(*phases, phase(kind, "accepted", nil))
	old, _ := (*row)["result"].(map[string]any)
	saved, e := s.update(ctx, *row, *phases, (*row)["target_operator_id"], old["revision"], nil)
	if e != nil {
		return nil, e
	}
	*row = saved
	result, runError := run()
	if runError != nil {
		result = phase(kind, "failed", safeCode(runError))
	} else if !includes([]string{"confirmed", "submitted", "failed", "unknown"}, str(result["state"])) {
		result = phase(kind, "unknown", "management_identity_response_invalid")
	}
	p := phase(kind, str(result["state"]), result["code"])
	if whole(result["revokedSessions"], 0, 9007199254740991) {
		p["revokedSessions"] = result["revokedSessions"]
	}
	if result["inflightBlocked"] == true {
		p["inflightBlocked"] = true
	}
	(*phases)[len(*phases)-1] = p
	revision := result["revision"]
	if revision == nil {
		revision = old["revision"]
	}
	saved, e = s.update(ctx, *row, *phases, (*row)["target_operator_id"], revision, nil)
	if e == nil {
		*row = saved
	}
	return result, e
}
func (s *Service) finish(ctx context.Context, row Object, phases []Object, a Actor) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		result, _ := row["result"].(map[string]any)
		result = cloneObject(result)
		result["phases"] = phases
		saved, e := readObject(ctx, tx, `UPDATE operations_management_commands_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2 RETURNING to_jsonb(operations_management_commands_v1)`, s.Endpoint, row["operation_id"], stateOf(phases), jsonText(result), s.now())
		if e != nil {
			return nil, e
		}
		safePhases := []Object{}
		for _, p := range phases {
			safePhases = append(safePhases, Object{"kind": p["kind"], "state": p["state"]})
		}
		_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,http_request_id,selection,result,created_at,actor_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'business-operator')`, uuid.NewString(), s.Endpoint, a.ID, a.Role, "management-account-"+str(row["kind"]), row["operation_id"], a.RequestID, jsonText(Object{"targetOperatorId": saved["target_operator_id"], "kind": saved["kind"]}), jsonText(Object{"kind": saved["kind"], "state": saved["state"], "revision": result["revision"], "phases": safePhases}), s.now())
		return saved, e
	})
}
func (s *Service) invalidate(ctx context.Context, p Principal) error {
	if s.Sessions == nil {
		return nil
	}
	return s.Sessions.Invalidate(ctx, p)
}
func (s *Service) local(ctx context.Context, u *User, a Actor, fields Object, validate func(pgx.Tx) (Actor, error)) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if validate != nil {
			var e error
			a, e = validate(tx)
			if e != nil {
				return nil, e
			}
		}
		id := ID(u.Issuer, u.ExternalSubject)
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912463))`, jsonText([]any{s.Endpoint, id})); e != nil {
			return nil, e
		}
		if _, e := s.principalWithin(ctx, tx, u, a, ""); e != nil {
			return nil, e
		}
		return readObject(ctx, tx, `UPDATE operations_management_accounts_v1 SET version=version+1,note=COALESCE($3,note),login_blocked=COALESCE($4,login_blocked),deleted_at=CASE WHEN $5 THEN $6::timestamptz ELSE deleted_at END,updated_at=$6 WHERE endpoint=$1 AND operator_id=$2 RETURNING to_jsonb(operations_management_accounts_v1)`, s.Endpoint, id, fields["note"], fields["loginBlocked"], fields["deleted"] == true, s.now())
	})
}
func (s *Service) portal(ctx context.Context, p Principal) (Object, error) {
	if s.Sessions == nil {
		return nil, nativeError("management_sessions_unavailable")
	}
	r, e := s.Sessions.Revoke(ctx, p)
	if e != nil {
		return nil, e
	}
	if !whole(r["revokedSessions"], 0, 9007199254740991) || r["inflightBlocked"] != true {
		return Object{"state": "unknown", "code": "management_sessions_unavailable"}, nil
	}
	return Object{"state": "confirmed", "code": nil, "revokedSessions": r["revokedSessions"], "inflightBlocked": true}, nil
}
func childID(id, role string) string {
	b := sha256.Sum256([]byte(id + "\x00" + role))
	b[6] = (b[6] & 15) | 80
	b[8] = (b[8] & 63) | 128
	h := hex.EncodeToString(b[:16])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func (s *Service) initial(ctx context.Context, a Actor) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.actor(ctx, tx, a, "management.accounts.read") })
}
func (s *Service) Create(ctx context.Context, a Actor, input Object, authorize Authorize) (Object, error) {
	x, e := ParseCreate(input)
	if e != nil {
		return nil, e
	}
	original, e := s.initial(ctx, a)
	if e != nil {
		return nil, e
	}
	claim, e := s.reserve(ctx, original, "create", x, nil, nil, "management.accounts.create", authorize)
	if e != nil {
		return nil, e
	}
	if claim.old != nil {
		return s.stamp(receipt(claim.old, true)), nil
	}
	row, phases := claim.row, []Object{}
	gate := func() error { _, e := s.current(ctx, nil, original, "management.accounts.create", authorize); return e }
	finish := func() (Object, error) {
		r, e := s.finish(ctx, row, phases, claim.actor)
		if e != nil {
			return nil, e
		}
		return s.stamp(receipt(r, false)), nil
	}
	result, e := s.invoke(ctx, &row, &phases, "native-account", func() (Object, error) { return s.Directory.Create(ctx, x, gate) })
	if e != nil {
		return nil, e
	}
	if result["state"] != "confirmed" {
		return finish()
	}
	issuer, subject := str(result["issuer"]), str(result["externalSubject"])
	targetID := ID(issuer, subject)
	if s.rootTarget(issuer, subject) {
		phases[0] = phase("native-account", "unknown", "management_root_protected")
		return finish()
	}
	old, _ := row["result"].(map[string]any)
	row, e = s.update(ctx, row, phases, targetID, old["revision"], Object{"issuer": issuer, "externalSubject": subject})
	if e != nil {
		return nil, e
	}
	user, e := s.Directory.Get(ctx, issuer, subject)
	if e != nil || user == nil || !user.Enabled || !includes(user.RequiredActions, "UPDATE_PASSWORD") {
		code := "management_identity_response_invalid"
		if e != nil {
			code = safeCode(e)
		}
		phases[0] = phase("native-account", "unknown", code)
		return finish()
	}
	result, e = s.invoke(ctx, &row, &phases, "local-principal", func() (Object, error) {
		fresh, e := s.current(ctx, nil, original, "management.accounts.create", authorize)
		if e != nil {
			return nil, e
		}
		meta, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.principalWithin(ctx, tx, user, fresh, str(x["note"])) })
		if e != nil {
			return nil, e
		}
		return Object{"state": "confirmed", "revision": meta["version"]}, nil
	})
	if e != nil {
		return nil, e
	}
	if result["state"] == "confirmed" {
		_, e = s.invoke(ctx, &row, &phases, "native-admission", func() (Object, error) {
			r, e := s.Directory.Admission(ctx, issuer, subject, "reader", gate)
			if e != nil || r["state"] != "confirmed" {
				return r, e
			}
			if e = s.invalidate(ctx, Principal{targetID, issuer, subject}); e != nil {
				return nil, e
			}
			current, e := s.Directory.Get(ctx, issuer, subject)
			if e != nil {
				return nil, e
			}
			if current != nil && current.Admission == "reader" {
				return Object{"state": "confirmed"}, nil
			}
			return Object{"state": "unknown", "code": "management_identity_response_invalid"}, nil
		})
		if e != nil {
			return nil, e
		}
	}
	all := true
	for _, p := range phases {
		all = all && p["state"] == "confirmed"
	}
	if all && len(stringList(x["roleIds"])) > 0 {
		_, e = s.invoke(ctx, &row, &phases, "business-assignments", func() (Object, error) {
			for _, id := range stringList(x["roleIds"]) {
				fresh, e := s.current(ctx, nil, original, "management.accounts.create", authorize)
				if e != nil {
					return nil, e
				}
				if _, e = s.Assignment(ctx, fresh, targetID, Object{"operationId": childID(str(x["operationId"]), id), "expectedVersion": 0, "roleId": id, "enabled": true}, authorize); e != nil {
					return nil, e
				}
			}
			return Object{"state": "confirmed"}, nil
		})
		if e != nil {
			return nil, e
		}
	}
	if e = s.invalidate(ctx, Principal{targetID, issuer, subject}); e != nil {
		return nil, e
	}
	out, e := finish()
	if e != nil {
		return nil, e
	}
	if _, e = s.initial(ctx, original); e != nil {
		return nil, e
	}
	return out, nil
}

func (s *Service) Command(ctx context.Context, a Actor, id string, input Object, authorize Authorize) (Object, error) {
	x, e := ParseCommand(input)
	if e != nil {
		return nil, e
	}
	if !operatorPattern.MatchString(id) {
		return nil, invalid()
	}
	kind, action := str(x["kind"]), commandActions[str(x["kind"])]
	original, e := s.initial(ctx, a)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, nil, original, action, authorize); e != nil {
		return nil, e
	}
	prior, e := optionalObject(ctx, s.Pool, `SELECT to_jsonb(c) FROM operations_management_commands_v1 c WHERE operation_id=$1`, x["operationId"])
	if e != nil {
		return nil, e
	}
	if prior != nil {
		if prior["endpoint"] != s.Endpoint || prior["operator_id"] != original.ID || prior["target_operator_id"] != id || prior["kind"] != kind || !same(prior["input"], Intent(x)) {
			return nil, fault.New("management_operation_conflict", 409)
		}
		return s.stamp(receipt(prior, true)), nil
	}
	target, e := s.targetWithin(ctx, s.Pool, id)
	if e != nil {
		return nil, e
	}
	state, expected := s.native(ctx, target)
	if expected == nil {
		status, code := 503, "management_identity_unavailable"
		if state == "not-found" {
			status, code = 404, "management_identity_not_found"
		}
		return nil, fault.New(code, status)
	}
	claim, e := s.reserve(ctx, original, kind, x, &id, expected, action, authorize)
	if e != nil {
		return nil, e
	}
	if claim.old != nil {
		return s.stamp(receipt(claim.old, true)), nil
	}
	row, phases := claim.row, []Object{}
	p := Principal{id, expected.Issuer, expected.ExternalSubject}
	authority := func() (Actor, error) {
		a, e := s.current(ctx, nil, original, action, authorize)
		if e != nil {
			return Actor{}, e
		}
		if e = s.guard(a, expected, kind); e != nil {
			return Actor{}, e
		}
		return a, nil
	}
	gate := func() error {
		if _, e := authority(); e != nil {
			return e
		}
		live, e := s.Directory.Get(ctx, p.Issuer, p.ExternalSubject)
		if e != nil {
			return e
		}
		if live == nil || !same(live, expected) {
			return fault.New("management_identity_target_changed", 409)
		}
		local, e := s.targetWithin(ctx, s.Pool, id)
		if e != nil {
			return e
		}
		if local["deleted_at"] != nil {
			return fault.New("management_identity_target_changed", 409)
		}
		_, e = authority()
		return e
	}
	perform := func(phase string, run func() (Object, error)) (Object, error) {
		return s.invoke(ctx, &row, &phases, phase, run)
	}
	saveLocal := func(fields Object) (Object, error) {
		a, e := authority()
		if e != nil {
			return nil, e
		}
		meta, e := s.local(ctx, expected, a, fields, func(tx pgx.Tx) (Actor, error) { return s.current(ctx, tx, original, action, authorize) })
		if e != nil {
			return nil, e
		}
		if e = s.invalidate(ctx, p); e != nil {
			return nil, e
		}
		return Object{"state": "confirmed", "revision": meta["version"]}, nil
	}
	revoke := func(missing bool) error {
		if !missing {
			if _, e := perform("native-sessions", func() (Object, error) { return s.Directory.Logout(ctx, p.Issuer, p.ExternalSubject, gate) }); e != nil {
				return e
			}
		}
		_, e := perform("portal-sessions", func() (Object, error) {
			if _, e := authority(); e != nil {
				return nil, e
			}
			return s.portal(ctx, p)
		})
		return e
	}
	liveRead := func() (*User, error) { return s.Directory.Get(ctx, p.Issuer, p.ExternalSubject) }
	switch kind {
	case "profile-update":
		result := Object{"state": "confirmed"}
		if _, ok := x["firstName"]; ok {
			result, e = perform("native-account", func() (Object, error) { return s.Directory.Profile(ctx, p.Issuer, p.ExternalSubject, x, gate) })
		} else if _, ok := x["lastName"]; ok {
			result, e = perform("native-account", func() (Object, error) { return s.Directory.Profile(ctx, p.Issuer, p.ExternalSubject, x, gate) })
		}
		if e != nil {
			return nil, e
		}
		if result["state"] == "confirmed" {
			live, e := liveRead()
			if e != nil {
				return nil, e
			}
			wanted := *expected
			if v, ok := x["firstName"]; ok {
				wanted.FirstName = str(v)
			}
			if v, ok := x["lastName"]; ok {
				wanted.LastName = str(v)
			}
			if !same(live, &wanted) {
				phases = append(phases, phase("native-account", "unknown", "management_identity_target_changed"))
			} else {
				expected = live
				if _, e = perform("local-principal", func() (Object, error) { return saveLocal(Object{"note": x["note"]}) }); e != nil {
					return nil, e
				}
			}
		}
	case "login-disable", "delete":
		if _, e = perform("local-principal", func() (Object, error) { return saveLocal(Object{"loginBlocked": true}) }); e != nil {
			return nil, e
		}
		all := true
		for _, p := range phases {
			all = all && p["state"] == "confirmed"
		}
		if all {
			r, e := perform("native-account", func() (Object, error) {
				if kind == "delete" {
					return s.Directory.Remove(ctx, p.Issuer, p.ExternalSubject, gate)
				}
				return s.Directory.SetEnabled(ctx, p.Issuer, p.ExternalSubject, false, gate)
			})
			if e != nil {
				return nil, e
			}
			if r["state"] == "confirmed" {
				live, e := liveRead()
				if e != nil {
					return nil, e
				}
				wanted := *expected
				wanted.Enabled = false
				if kind == "delete" && live == nil {
					if _, e = perform("local-principal", func() (Object, error) { return saveLocal(Object{"deleted": true, "loginBlocked": true}) }); e != nil {
						return nil, e
					}
					if e = revoke(true); e != nil {
						return nil, e
					}
				} else if kind == "login-disable" && live != nil && same(live, &wanted) {
					expected = live
					if e = revoke(false); e != nil {
						return nil, e
					}
				} else {
					phases = append(phases, phase("native-account", "unknown", "management_identity_target_changed"))
				}
			}
		}
	case "login-restore":
		r := Object{"state": "confirmed"}
		if !expected.Enabled {
			r, e = perform("native-account", func() (Object, error) { return s.Directory.SetEnabled(ctx, p.Issuer, p.ExternalSubject, true, gate) })
		}
		if e != nil {
			return nil, e
		}
		if r["state"] == "confirmed" {
			live, e := liveRead()
			if e != nil {
				return nil, e
			}
			wanted := *expected
			wanted.Enabled = true
			if live != nil && same(live, &wanted) {
				expected = live
				if _, e = perform("local-principal", func() (Object, error) { return saveLocal(Object{"loginBlocked": false}) }); e != nil {
					return nil, e
				}
			} else {
				phases = append(phases, phase("native-account", "unknown", "management_identity_target_changed"))
			}
		}
	case "password-reset":
		r, e := perform("native-account", func() (Object, error) {
			return s.Directory.ResetPassword(ctx, p.Issuer, p.ExternalSubject, str(x["temporaryPassword"]), gate)
		})
		if e != nil {
			return nil, e
		}
		if r["state"] == "confirmed" {
			live, e := liveRead()
			if e != nil {
				return nil, e
			}
			if live == nil || !includes(live.RequiredActions, "UPDATE_PASSWORD") {
				phases = append(phases, phase("native-account", "unknown", "management_identity_response_invalid"))
			} else {
				expected = live
				if _, e = perform("local-principal", func() (Object, error) { return saveLocal(Object{}) }); e != nil {
					return nil, e
				}
				if e = revoke(false); e != nil {
					return nil, e
				}
			}
		}
	case "sessions-revoke":
		if e = revoke(false); e != nil {
			return nil, e
		}
	case "admission-change":
		desired := "reader"
		if x["action"] == "promote" {
			desired = "administrator"
		}
		r, e := perform("native-admission", func() (Object, error) { return s.Directory.Admission(ctx, p.Issuer, p.ExternalSubject, desired, gate) })
		if e != nil {
			return nil, e
		}
		if r["state"] == "confirmed" {
			live, e := liveRead()
			if e != nil {
				return nil, e
			}
			if e = s.invalidate(ctx, p); e != nil {
				return nil, e
			}
			if live == nil || live.Admission != desired {
				phases = append(phases, phase("native-admission", "unknown", "management_identity_response_invalid"))
			} else {
				expected = live
				if _, e = perform("local-principal", func() (Object, error) { return saveLocal(Object{}) }); e != nil {
					return nil, e
				}
				if e = revoke(false); e != nil {
					return nil, e
				}
			}
		}
	case "email-change":
		if _, e = perform("email-verification", func() (Object, error) {
			return s.Directory.RequestEmailChange(ctx, p.Issuer, p.ExternalSubject, str(x["newEmail"]), str(x["operationId"]), gate)
		}); e != nil {
			return nil, e
		}
	}
	row, e = s.finish(ctx, row, phases, claim.actor)
	if e != nil {
		return nil, e
	}
	if _, e = s.initial(ctx, original); e != nil {
		return nil, e
	}
	return s.stamp(receipt(row, false)), nil
}

func (s *Service) Assignment(ctx context.Context, a Actor, id string, input Object, authorize Authorize) (Object, error) {
	x, e := ParseAssignment(input)
	if e != nil {
		return nil, e
	}
	original, e := s.initial(ctx, a)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, nil, original, "permissions.assignments.write", authorize); e != nil {
		return nil, e
	}
	source, e := s.targetWithin(ctx, s.Pool, id)
	if e != nil {
		return nil, e
	}
	_, u := s.native(ctx, source)
	if u == nil {
		return nil, nativeError("management_identity_unavailable")
	}
	check := func(q Querier, a Actor) (*User, error) {
		meta, e := s.targetWithin(ctx, q, id)
		if e != nil {
			return nil, e
		}
		u, e := s.Directory.Get(ctx, str(source["issuer"]), str(source["external_subject"]))
		if e != nil {
			return nil, e
		}
		if u == nil || !u.Enabled || u.Admission == "none" || meta["login_blocked"] == true || meta["deleted_at"] != nil {
			return nil, fault.New("management_identity_target_changed", 409)
		}
		if e = s.guard(a, u, "assignment"); e != nil {
			return nil, e
		}
		return u, nil
	}
	u, e = check(s.Pool, original)
	if e != nil {
		return nil, e
	}
	if e = within(ctx, s.Pool, func(tx pgx.Tx) error { _, e := s.principalWithin(ctx, tx, u, original, ""); return e }); e != nil {
		return nil, e
	}
	if s.Permissions == nil {
		return nil, nativeError("operations_authorization_unavailable")
	}
	x["operatorId"] = id
	result, e := s.Permissions.SaveAssignmentWithTarget(ctx, original, x, func(ctx context.Context, tx pgx.Tx, a Actor) error {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912463))`, jsonText([]any{s.Endpoint, id})); e != nil {
			return e
		}
		_, e := check(tx, a)
		return e
	})
	if e != nil {
		return nil, e
	}
	if e = s.invalidate(ctx, Principal{id, u.Issuer, u.ExternalSubject}); e != nil {
		return nil, e
	}
	return result, nil
}
func (s *Service) AssignmentOperation(ctx context.Context, a Actor, id, operationID string) (Object, error) {
	if !uuidPattern.MatchString(operationID) {
		return nil, invalid()
	}
	return s.read(ctx, a, func(tx pgx.Tx, a Actor) (Object, error) {
		if _, e := s.targetWithin(ctx, tx, id); e != nil {
			return nil, e
		}
		r, e := optionalObject(ctx, tx, `SELECT to_jsonb(e) FROM operations_permission_events_v1 e WHERE endpoint=$1 AND id=$2 AND kind='assignment-save'`, s.Endpoint, operationID)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return Object{"state": "not-recorded", "operationId": operationID, "kind": nil, "selection": nil, "result": nil}, nil
		}
		input, _ := r["input"].(map[string]any)
		if r["operator_id"] != a.ID || input["operatorId"] != id {
			return nil, fault.New("management_operation_not_found", 404)
		}
		selection := Object{"operationId": input["operationId"], "expectedVersion": input["expectedVersion"], "roleId": input["roleId"], "enabled": input["enabled"]}
		if input["id"] != nil {
			selection["id"] = input["id"]
		}
		x, e := ParseAssignment(selection)
		if e != nil {
			return nil, e
		}
		result, _ := r["result"].(map[string]any)
		assignment, _ := result["assignment"].(map[string]any)
		if assignment == nil || !uuidPattern.MatchString(str(assignment["id"])) || assignment["operatorId"] != id || assignment["roleId"] != x["roleId"] || !whole(assignment["version"], 1, 9007199254740991) {
			return nil, nativeError("management_command_unavailable")
		}
		if _, ok := assignment["enabled"].(bool); !ok {
			return nil, nativeError("management_command_unavailable")
		}
		for _, v := range []any{assignment["createdAt"], assignment["updatedAt"], result["recordedAt"]} {
			if _, ok := v.(string); !ok || nullableStamp(v) == nil {
				return nil, nativeError("management_command_unavailable")
			}
		}
		delete(x, "operationId")
		if x["id"] == nil {
			x["id"] = nil
		}
		x["operatorId"] = id
		return Object{"state": "recorded", "operationId": operationID, "operatorId": r["operator_id"], "kind": "assignment-save", "selection": x, "result": Object{"assignment": Object{"id": assignment["id"], "operatorId": id, "roleId": assignment["roleId"], "enabled": assignment["enabled"], "version": assignment["version"], "createdAt": assignment["createdAt"], "updatedAt": assignment["updatedAt"]}, "operationId": operationID, "recordedAt": result["recordedAt"], "replayed": true}}, nil
	})
}
