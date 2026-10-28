package registeredusers

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

var resultCodes = []string{"registered_identity_submission_unknown", "registered_identity_write_forbidden", "registered_identity_client_unavailable", "registered_identity_not_found", "registered_identity_changed", "registered_identity_write_failed", "registered_identity_management_not_configured", "registered_identity_target_changed", "registered_command_unavailable", "registered_website_sessions_unavailable", "registered_website_session_fence_unconfirmed", "operations_permission_denied", "business_admin_denied", "operations_authorization_unavailable"}

func SafeResult(value Object) Object {
	effects := Object{}
	for _, k := range []string{"identity", "ssoSessions", "websiteSessions", "profile"} {
		r := obj(obj(value["effects"])[k])
		if r == nil || !has([]string{"confirmed", "submitted", "failed", "unknown", "not-required", "not-configured"}, str(r["state"])) {
			continue
		}
		var code any
		if has(resultCodes, str(r["code"])) {
			code = r["code"]
		}
		o := Object{"state": r["state"], "code": code}
		for _, key := range []string{"revokedSessions", "revision"} {
			if v, ok := r[key]; ok && whole(v, 0, 9007199254740991) {
				o[key] = v
			}
		}
		effects[k] = o
	}
	out := Object{"effects": effects, "passwordChanged": nil, "participationChanged": false}
	if value["passwordChanged"] == false {
		out["passwordChanged"] = false
	}
	change := obj(value["correction"])
	validDisplay := func(v any) bool {
		if v == nil {
			return true
		}
		s, ok := v.(string)
		return ok && protocol.TextLength(s) <= 120
	}
	if change["field"] == "displayName" && validDisplay(change["before"]) && validDisplay(change["after"]) {
		out["correction"] = Object{"field": "displayName", "before": change["before"], "after": change["after"]}
	}
	if raw, ok := value["changedFields"].([]any); ok {
		fields := []string{}
		for _, k := range []string{"displayName", "avatarKey", "bio"} {
			for _, v := range raw {
				if v == k {
					fields = append(fields, k)
					break
				}
			}
		}
		out["changedFields"] = fields
	} else if raw, ok := value["changedFields"].([]string); ok {
		fields := []string{}
		for _, k := range []string{"displayName", "avatarKey", "bio"} {
			if has(raw, k) {
				fields = append(fields, k)
			}
		}
		out["changedFields"] = fields
	}
	preset := obj(value["preset"])
	if uuidPattern.MatchString(str(preset["reservedAccountId"])) && accounts.UIDPattern.MatchString(str(preset["uid"])) && whole(preset["revision"], 1, 9007199254740991) {
		out["preset"] = Object{"reservedAccountId": preset["reservedAccountId"], "uid": preset["uid"], "revision": preset["revision"]}
	}
	return out
}
func (s *Service) receipt(row Object, replayed bool) Object {
	return Object{"state": row["state"], "operationId": row["operation_id"], "registrationId": row["registration_id"], "kind": row["kind"], "result": SafeResult(obj(row["result"])), "recordedAt": nullableStamp(row["created_at"]), "replayed": replayed}
}
func (s *Service) historyWithin(ctx context.Context, tx pgx.Tx, id string, input Object) (Object, error) {
	x, e := ParseHistory(input)
	if e != nil {
		return nil, e
	}
	var after any = x["after"]
	limit := int(integer(x["limit"]))
	rows, e := many(ctx, tx, `SELECT to_jsonb(q) FROM(SELECT c.sequence::text,c.operation_id,c.operator_id,c.kind,c.state,c.result,c.input,c.created_at,c.updated_at,o.display_name AS operator_display_name FROM operations_registered_commands_v1 c LEFT JOIN operations_operator_principals_v1 o ON o.endpoint=c.endpoint AND o.operator_id=c.operator_id WHERE c.endpoint=$1 AND c.registration_id=$2 AND ($3::bigint IS NULL OR c.sequence<$3) ORDER BY c.sequence DESC LIMIT $4)q`, s.Endpoint, id, after, limit+1)
	if e != nil {
		return nil, e
	}
	var next any
	if len(rows) > limit {
		next = rows[limit-1]["sequence"]
		rows = rows[:limit]
	}
	items := []Object{}
	for _, r := range rows {
		var name, reason, basis any
		if v, ok := r["operator_display_name"].(string); ok && protocol.TextLength(v) <= 240 {
			name = v
		}
		input := obj(r["input"])
		if v, ok := input["reason"].(string); ok && protocol.TextLength(v) <= 1000 {
			reason = v
		}
		if has([]string{"profile-correct", "profile-preset"}, str(r["kind"])) {
			if v, ok := input["basis"].(string); ok && protocol.TextLength(v) <= 1000 {
				basis = v
			}
		}
		items = append(items, Object{"sequence": r["sequence"], "operationId": r["operation_id"], "operatorId": r["operator_id"], "kind": r["kind"], "state": r["state"], "operatorDisplayName": name, "reason": reason, "basis": basis, "result": SafeResult(obj(r["result"])), "createdAt": nullableStamp(r["created_at"]), "updatedAt": nullableStamp(r["updated_at"])})
	}
	return Object{"items": items, "nextAfter": next}, nil
}
func (s *Service) History(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		if _, e := s.targetWithin(ctx, tx, id); e != nil {
			return nil, e
		}
		return s.historyWithin(ctx, tx, id, input)
	})
}
func (s *Service) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	return s.read(ctx, a, func(tx pgx.Tx, current Actor) (Object, error) {
		r, e := optionalObject(ctx, tx, `SELECT to_jsonb(c) FROM operations_registered_commands_v1 c WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, id)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return Object{"state": "not-recorded", "operationId": id, "registrationId": nil, "kind": nil, "result": nil, "recordedAt": nil, "replayed": false}, nil
		}
		if r["operator_id"] != current.ID {
			return nil, fail("registered_operation_not_found", 404)
		}
		if _, e = s.targetWithin(ctx, tx, str(r["registration_id"])); e != nil {
			return nil, e
		}
		return s.receipt(r, true), nil
	})
}
