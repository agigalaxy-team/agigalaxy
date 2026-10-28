package registeredusers

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func same(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func effect(state string, code any) Object { return Object{"state": state, "code": code} }
func controlledError(e error) string {
	code := fault.Code(e)
	if has([]string{"operations_permission_denied", "business_admin_denied", "operations_authorization_unavailable", "registered_identity_not_found", "registered_identity_management_not_configured", "registered_identity_target_changed"}, code) {
		return code
	}
	return "registered_command_unavailable"
}
func (s *Service) fresh(ctx context.Context, tx pgx.Tx, original Actor, action string, authorize func() (Actor, error)) (Actor, error) {
	if authorize == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	fresh, e := authorize()
	if e != nil {
		return Actor{}, e
	}
	if fresh.AIProof != nil || fresh.ID != original.ID || fresh.Endpoint != s.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if _, e = s.actor(ctx, tx, fresh, ""); e != nil {
		return Actor{}, e
	}
	return s.actor(ctx, tx, fresh, action)
}
func (s *Service) freshOutside(ctx context.Context, a Actor, action string, authorize func() (Actor, error)) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.fresh(ctx, tx, a, action, authorize) })
}
func (s *Service) auditWithin(ctx context.Context, tx pgx.Tx, a Actor, id, kind string, receipt Object, accountID any) error {
	r := obj(receipt["result"])
	profile := obj(obj(r["effects"])["profile"])
	selection := Object{"registrationId": receipt["registrationId"], "kind": kind}
	result := Object{"state": receipt["state"], "kind": kind, "profileRevision": profile["revision"]}
	_, e := tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, uuid.NewString(), s.Endpoint, a.ID, a.Role, "registered-user-"+kind, accountID, id, a.RequestID, selection, result, s.now())
	return e
}

type claim struct{ old, saved, row Object }

func (s *Service) Command(ctx context.Context, a Actor, id string, input Object, authorize func() (Actor, error)) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	x, e := ParseCommand(input)
	if e != nil {
		return nil, e
	}
	kind, operation := str(x["kind"]), str(x["operationId"])
	action := CommandActions[kind]
	original, e := s.current(ctx, a, "")
	if e != nil {
		return nil, e
	}
	if _, e = s.freshOutside(ctx, original, action, authorize); e != nil {
		return nil, e
	}
	target, e := s.targetWithin(ctx, s.Pool, id)
	if e != nil {
		return nil, e
	}
	native, state := s.native(ctx, target)
	if kind != "profile-correct" && native == nil {
		if state == "not-found" {
			return nil, fail("registered_identity_not_found", 404)
		}
		return nil, fail("registered_identity_unavailable", 503)
	}
	editsProfile := kind == "profile-preset"
	_, avatarGiven := x["avatarKey"]
	_, bioGiven := x["bio"]
	editsProfile = editsProfile || kind == "profile-correct" && (avatarGiven || bioGiven)
	reservation, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (claim, error) {
		lock, _ := protocol.EncodeJS([]any{s.Endpoint, operation})
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912452))`, string(lock)); e != nil {
			return claim{}, e
		}
		actor, e := s.fresh(ctx, tx, original, action, authorize)
		if e != nil {
			return claim{}, e
		}
		if kind == "password-reset" {
			if _, e = s.actor(ctx, tx, actor, "accounts.identity.read"); e != nil {
				return claim{}, e
			}
		}
		if editsProfile {
			if _, e = s.actor(ctx, tx, actor, "accounts.read"); e != nil {
				return claim{}, e
			}
		}
		old, e := optionalObject(ctx, tx, `SELECT to_jsonb(c) FROM operations_registered_commands_v1 c WHERE operation_id=$1`, operation)
		if e != nil {
			return claim{}, e
		}
		if old != nil {
			if old["endpoint"] != s.Endpoint || old["operator_id"] != actor.ID || old["registration_id"] != id || !same(old["input"], x) {
				return claim{}, fail("registered_operation_conflict", 409)
			}
			return claim{old: old}, nil
		}
		lock, _ = protocol.EncodeJS([]any{s.Endpoint, id})
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912453))`, string(lock)); e != nil {
			return claim{}, e
		}
		var active bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_registered_commands_v1 WHERE endpoint=$1 AND registration_id=$2 AND state IN ('accepted','unknown'))`, s.Endpoint, id).Scan(&active); e != nil {
			return claim{}, e
		}
		if active {
			return claim{}, fail("registered_operation_pending", 409)
		}
		row, e := s.targetWithin(ctx, tx, id)
		if e != nil {
			return claim{}, e
		}
		version, e := TargetVersion(row, native)
		if e != nil {
			return claim{}, e
		}
		if version != x["expectedVersion"] {
			return claim{}, fail("registered_user_changed", 409)
		}
		if kind == "profile-preset" || kind == "profile-correct" {
			result, accountID, e := s.profileWithin(ctx, tx, actor, id, row, x)
			if e != nil {
				return claim{}, e
			}
			saved, e := readObject(ctx, tx, `INSERT INTO operations_registered_commands_v1(operation_id,endpoint,operator_id,registration_id,kind,state,input,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'completed',$6,$7,$8,$8) RETURNING to_jsonb(operations_registered_commands_v1)`, operation, s.Endpoint, actor.ID, id, kind, x, result, s.now())
			if e != nil {
				return claim{}, e
			}
			final, e := s.fresh(ctx, tx, original, action, authorize)
			if e != nil {
				return claim{}, e
			}
			if editsProfile {
				if _, e = s.actor(ctx, tx, final, "accounts.read"); e != nil {
					return claim{}, e
				}
			}
			if e = s.auditWithin(ctx, tx, actor, operation, kind, s.receipt(saved, false), accountID); e != nil {
				return claim{}, e
			}
			return claim{old: saved}, nil
		}
		if s.Directory == nil || !s.Directory.ManagementConfigured() {
			return claim{}, fail("registered_identity_management_not_configured", 503)
		}
		if kind == "password-reset" && (!native.Enabled || native.Email == nil || *native.Email == "" || !native.EmailVerified) {
			return claim{}, fail("registered_reset_link_ineligible", 409)
		}
		if kind == "login-disable" && !native.Enabled || kind == "login-restore" && native.Enabled {
			return claim{}, fail("registered_user_changed", 409)
		}
		var password any
		if kind == "password-reset" {
			password = false
		}
		saved, e := readObject(ctx, tx, `INSERT INTO operations_registered_commands_v1(operation_id,endpoint,operator_id,registration_id,kind,state,input,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8,$8) RETURNING to_jsonb(operations_registered_commands_v1)`, operation, s.Endpoint, actor.ID, id, kind, x, Object{"effects": Object{}, "passwordChanged": password, "participationChanged": false}, s.now())
		if e != nil {
			return claim{}, e
		}
		if e = s.auditWithin(ctx, tx, actor, operation, kind, s.receipt(saved, false), row["account_id"]); e != nil {
			return claim{}, e
		}
		return claim{saved: saved, row: row}, nil
	})
	if e != nil {
		return nil, e
	}
	if reservation.old != nil {
		return s.stamp(s.receipt(reservation.old, true)), nil
	}
	issuer, subject := str(reservation.row["issuer"]), str(reservation.row["external_subject"])
	effects := Object{}
	expected := *native
	gate := func() error {
		if _, e := s.freshOutside(ctx, original, action, authorize); e != nil {
			return e
		}
		current, _ := s.native(ctx, reservation.row)
		if current == nil {
			return fail("registered_identity_not_found", 409)
		}
		equal := current.Issuer == expected.Issuer && current.ExternalSubject == expected.ExternalSubject && same(current.Email, expected.Email) && current.EmailVerified == expected.EmailVerified && current.Enabled == expected.Enabled && same(current.RegisteredAt, expected.RegisteredAt) && current.ServiceAccount == expected.ServiceAccount
		if !equal {
			return fail("registered_identity_target_changed", 409)
		}
		_, e := s.freshOutside(ctx, original, action, authorize)
		return e
	}
	invoke := func(key string, run func() (Object, error)) Object {
		r, e := run()
		if e != nil {
			r = effect("failed", controlledError(e))
		}
		effects[key] = r
		return r
	}
	if kind == "password-reset" {
		invoke("identity", func() (Object, error) { return s.Directory.ResetLink(ctx, issuer, subject, gate) })
	}
	if kind == "login-disable" || kind == "login-restore" {
		r := invoke("identity", func() (Object, error) {
			return s.Directory.SetEnabled(ctx, issuer, subject, kind == "login-restore", gate)
		})
		if r["state"] == "confirmed" {
			expected.Enabled = kind == "login-restore"
		}
	}
	if kind == "sessions-revoke" || kind == "login-disable" && obj(effects["identity"])["state"] == "confirmed" {
		invoke("ssoSessions", func() (Object, error) { return s.Directory.Logout(ctx, issuer, subject, gate) })
		invoke("websiteSessions", func() (Object, error) {
			if e := gate(); e != nil {
				return nil, e
			}
			if s.Portal == nil {
				return effect("not-configured", "registered_website_sessions_unavailable"), nil
			}
			var accountID *string
			if v, ok := reservation.row["account_id"].(string); ok {
				accountID = &v
			}
			r, e := s.Portal.Revoke(ctx, issuer, subject, accountID)
			if e != nil {
				return nil, e
			}
			if !whole(r["revokedSessions"], 0, 9007199254740991) || r["inflightBlocked"] != true {
				return effect("unknown", "registered_website_session_fence_unconfirmed"), nil
			}
			count := integer(r["revokedSessions"])
			r = effect("confirmed", nil)
			r["revokedSessions"] = count
			return r, nil
		})
	}
	allConfirmed, allSubmitted, anyConfirmed, unknown := true, true, false, false
	for _, v := range effects {
		state := obj(v)["state"]
		allConfirmed = allConfirmed && state == "confirmed"
		allSubmitted = allSubmitted && state == "submitted"
		anyConfirmed = anyConfirmed || state == "confirmed" || state == "submitted"
		unknown = unknown || state == "unknown"
	}
	finalState := "failed"
	switch {
	case unknown:
		finalState = "unknown"
	case allConfirmed:
		finalState = "completed"
	case allSubmitted:
		finalState = "submitted"
	case anyConfirmed:
		finalState = "partial"
	}
	var password any
	if kind == "password-reset" {
		password = false
	}
	result := SafeResult(Object{"effects": effects, "passwordChanged": password, "participationChanged": false})
	saved, e := readObject(ctx, s.Pool, `UPDATE operations_registered_commands_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2 RETURNING to_jsonb(operations_registered_commands_v1)`, s.Endpoint, operation, finalState, result, s.now())
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, original, ""); e != nil {
		return nil, e
	}
	return s.stamp(s.receipt(saved, false)), nil
}
func (s *Service) profileWithin(ctx context.Context, tx pgx.Tx, a Actor, id string, row, x Object) (Object, any, error) {
	kind := str(x["kind"])
	if kind == "profile-preset" {
		if row["account_id"] != nil {
			return nil, nil, fail("registered_business_profile_already_formed", 409)
		}
		accountService := s.Accounts
		if accountService == nil {
			accountService = &accounts.Service{Endpoint: s.Endpoint, Now: s.Now}
		}
		reserved, e := accountService.ReserveWithin(ctx, tx, accounts.Identity{Issuer: str(row["issuer"]), ExternalSubject: str(row["external_subject"])})
		if e != nil {
			return nil, nil, e
		}
		live, e := s.targetWithin(ctx, tx, id)
		if e != nil {
			return nil, nil, e
		}
		if live["account_id"] != nil {
			return nil, nil, fail("registered_business_profile_already_formed", 409)
		}
		preset, e := readObject(ctx, tx, `SELECT to_jsonb(r) FROM official_account_registrations_v1 r WHERE account_id=$1 FOR UPDATE`, reserved.AccountID)
		if e != nil {
			return nil, nil, e
		}
		if preset["adopted_at"] != nil || integer(preset["preset_revision"]) != integer(x["expectedPresetRevision"]) {
			return nil, nil, fail("registered_user_changed", 409)
		}
		before := Object{"displayName": valueDefault(preset["display_name"], reserved.UID), "avatarKey": preset["avatar_key"], "bio": valueDefault(preset["bio"], "")}
		after := cloneObject(before)
		for _, k := range []string{"displayName", "avatarKey", "bio"} {
			if v, ok := x[k]; ok {
				after[k] = v
			}
		}
		var revision int64
		e = tx.QueryRow(ctx, `UPDATE official_account_registrations_v1 SET display_name=$2,avatar_key=$3,bio=$4,preset_revision=preset_revision+1,preset_updated_by=$5,updated_at=$6 WHERE account_id=$1 RETURNING preset_revision`, reserved.AccountID, after["displayName"], after["avatarKey"], after["bio"], a.ID, s.now()).Scan(&revision)
		if e != nil {
			return nil, nil, e
		}
		fields := []string{}
		for _, k := range []string{"displayName", "avatarKey", "bio"} {
			if !same(before[k], after[k]) {
				fields = append(fields, k)
			}
		}
		return Object{"effects": Object{"profile": Object{"state": "confirmed", "code": nil, "revision": revision}}, "passwordChanged": nil, "participationChanged": false, "changedFields": fields, "preset": Object{"reservedAccountId": reserved.AccountID, "uid": reserved.UID, "revision": revision}}, nil, nil
	}
	if row["profile_account_id"] == nil {
		return nil, nil, fail("registered_business_profile_missing", 409)
	}
	profile, e := optionalObject(ctx, tx, `SELECT to_jsonb(p) FROM(SELECT revision,display_name,avatar_key,bio FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE)p`, row["account_id"])
	if e != nil {
		return nil, nil, e
	}
	if profile == nil || integer(profile["revision"]) != integer(x["expectedProfileRevision"]) || integer(profile["revision"]) != integer(row["profile_revision"]) {
		return nil, nil, fail("registered_user_changed", 409)
	}
	before := Object{"displayName": profile["display_name"], "avatarKey": profile["avatar_key"], "bio": valueDefault(profile["bio"], "")}
	after := cloneObject(before)
	for _, k := range []string{"displayName", "avatarKey", "bio"} {
		if v, ok := x[k]; ok {
			after[k] = v
		}
	}
	var revision int64
	e = tx.QueryRow(ctx, `UPDATE official_account_profiles_v1 SET display_name=$2,revision=revision+1,updated_at=$3,avatar_key=$4,bio=$5 WHERE account_id=$1 RETURNING revision`, row["account_id"], after["displayName"], s.now(), after["avatarKey"], after["bio"]).Scan(&revision)
	if e != nil {
		return nil, nil, e
	}
	fields := []string{}
	for _, k := range []string{"displayName", "avatarKey", "bio"} {
		if !same(before[k], after[k]) {
			fields = append(fields, k)
		}
	}
	r := Object{"effects": Object{"profile": Object{"state": "confirmed", "code": nil, "revision": revision}}, "passwordChanged": nil, "participationChanged": false, "changedFields": fields}
	if has(fields, "displayName") {
		r["correction"] = Object{"field": "displayName", "before": profile["display_name"], "after": x["displayName"]}
	}
	return r, row["account_id"], nil
}
