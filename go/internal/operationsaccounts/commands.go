package operationsaccounts

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"slices"
	"time"
	"unicode/utf8"
)

func ParseTypeChange(input Object) (Object, error) {
	if !strict(input, []string{"operationId", "expectedRevision", "subjectType", "reason", "basis", "preserveHistory"}, nil) || !validID(str(input["operationId"])) || input["preserveHistory"] != true || !slices.Contains([]string{"person", "organization", "agent"}, str(input["subjectType"])) {
		return nil, invalid()
	}
	if _, ok := number(input["expectedRevision"]); !ok {
		return nil, invalid()
	}
	out := Object{}
	for k, v := range input {
		out[k] = v
	}
	for k, max := range map[string]int{"reason": 2000, "basis": 4000} {
		text, ok := out[k].(string)
		text = trim(text)
		if !ok || utf8.RuneCountInString(text) < 8 || utf8.RuneCountInString(text) > max {
			return nil, invalid()
		}
		out[k] = text
	}
	return out, nil
}
func (s *Service) ChangeType(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	x, e := ParseTypeChange(input)
	if e != nil {
		return nil, e
	}
	if !validID(id) {
		return nil, invalid()
	}
	d := s.domain()
	if d == nil || d.Pool == nil || s.Accounts == nil {
		return nil, fail("business_admin_unavailable", 503)
	}
	return postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Object, error) {
		selected := Object{"accountId": id}
		for k, v := range x {
			selected[k] = v
		}
		actor, e := d.Operation(ctx, tx, a, "type-change", selected)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, d.Endpoint+":business-admin:"+str(x["operationId"])); e != nil {
			return nil, e
		}
		old, e := one(ctx, tx, `SELECT to_jsonb(r) FROM business_admin_audit_v1 r WHERE endpoint=$1 AND operation_id=$2`, d.Endpoint, x["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if old["operator_id"] != actor.ID || old["account_id"] != id || old["action"] != "type-change" || !equal(old["selection"], x) {
				return nil, fail("business_admin_operation_conflict", 409)
			}
			out := Object{}
			for k, v := range obj(old["result"]) {
				out[k] = v
			}
			out["replayed"] = true
			return out, nil
		}
		if _, e = s.AccountWithin(ctx, tx, id, true); e != nil {
			return nil, e
		}
		if d.IsDuty(actor) || d.IsExecution(actor) {
			return nil, fail("business_admin_denied", 403)
		}
		body := Object{}
		for k, v := range x {
			if k != "operationId" {
				body[k] = v
			}
		}
		raw, e := protocol.Encode(body)
		if e != nil {
			return nil, e
		}
		result, e := s.Accounts.ChangeTypeWithin(ctx, tx, id, raw, accounts.TypeSource{Kind: "business-operator", OperatorID: actor.ID, Endpoint: d.Endpoint}, func(ctx context.Context, tx pgx.Tx, operator, permission string) error {
			if operator != actor.ID {
				return fail("business_admin_denied", 403)
			}
			_, e := d.Fresh(ctx, tx, actor, permission)
			return e
		})
		if e != nil {
			return nil, e
		}
		result["operationId"], result["recordedAt"] = x["operationId"], stamp(s.now())
		if e = d.RecordAccountOperation(ctx, tx, actor, "type-change", x, result, id, x["operationId"]); e != nil {
			return nil, e
		}
		return result, nil
	})
}

func ParseRestriction(input Object, release bool) (Object, error) {
	required := []string{"operationId", "expectedRevision", "reason"}
	if !release {
		required = append(required, "until")
	}
	if !strict(input, required, nil) || !validID(str(input["operationId"])) {
		return nil, invalid()
	}
	if _, ok := number(input["expectedRevision"]); !ok {
		return nil, invalid()
	}
	reason, ok := input["reason"].(string)
	reason = trim(reason)
	if !ok || utf8.RuneCountInString(reason) < 3 || utf8.RuneCountInString(reason) > 2000 {
		return nil, invalid()
	}
	x := Object{"operationId": input["operationId"], "expectedRevision": input["expectedRevision"], "reason": reason}
	if !release {
		until := str(input["until"])
		if _, e := time.Parse(time.RFC3339Nano, until); e != nil {
			return nil, invalid()
		}
		x["until"] = until
	}
	return x, nil
}
func (s *Service) Restrict(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.changeRestriction(ctx, a, id, input, false)
}
func (s *Service) ReleaseRestriction(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.changeRestriction(ctx, a, id, input, true)
}
func (s *Service) changeRestriction(ctx context.Context, a Actor, id string, input Object, release bool) (Object, error) {
	x, e := ParseRestriction(input, release)
	if e != nil {
		return nil, e
	}
	if !validID(id) {
		return nil, invalid()
	}
	d := s.domain()
	if d == nil || d.Pool == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	action, permission := "restriction-set", "accounts.restriction.apply"
	if release {
		action, permission = "restriction-release", "accounts.restriction.release"
	}
	return postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Object, error) {
		selection := Object{"accountId": id}
		for k, v := range x {
			selection[k] = v
		}
		actor, e := d.Operation(ctx, tx, a, action, selection)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, d.Endpoint+":business-admin:"+str(x["operationId"])); e != nil {
			return nil, e
		}
		previous, e := one(ctx, tx, `SELECT to_jsonb(a) FROM business_admin_audit_v1 a WHERE endpoint=$1 AND operation_id=$2`, d.Endpoint, x["operationId"])
		if e != nil {
			return nil, e
		}
		if previous != nil {
			if previous["operator_id"] != actor.ID || previous["account_id"] != id || previous["action"] != action || !equal(previous["selection"], x) {
				return nil, fail("business_admin_operation_conflict", 409)
			}
			result := obj(previous["result"])
			out := Object{}
			for k, v := range result {
				out[k] = v
			}
			out["replayed"] = true
			return out, nil
		}
		row, e := s.AccountWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		// This original helper accepts real human business operators or an attested
		// duty. A generic program executor cannot turn itself into either source.
		if d.IsExecution(actor) {
			return nil, fail("business_admin_denied", 403)
		}
		if _, e = d.Fresh(ctx, tx, actor, permission); e != nil {
			return nil, e
		}
		if num(row["restriction_revision"]) != num(x["expectedRevision"]) {
			return nil, fail("account_restriction_changed", 409)
		}
		if d.IsDuty(actor) {
			if e = s.priorDutyRestrictionWithin(ctx, tx, actor, id, row); e != nil {
				return nil, e
			}
		}
		var until, reason any
		if !release {
			t, _ := time.Parse(time.RFC3339Nano, str(x["until"]))
			if !t.After(s.now()) {
				return nil, fail("invalid_restriction_expiry", 400)
			}
			until, reason = t, x["reason"]
		}
		before := s.restriction(row)
		changed, e := one(ctx, tx, `WITH r AS (UPDATE community_accounts SET restricted_until=$3,restriction_reason=$4,restriction_revision=restriction_revision+1 WHERE id=$1 AND endpoint=$2 RETURNING *) SELECT to_jsonb(r) FROM r`, id, d.Endpoint, until, reason)
		if e != nil {
			return nil, e
		}
		result := Object{"accountId": id, "before": before, "restriction": s.restriction(changed), "operationId": x["operationId"], "recordedAt": stamp(s.now())}
		if e = d.RecordAccountOperation(ctx, tx, actor, action, x, result, id, x["operationId"]); e != nil {
			return nil, e
		}
		return result, nil
	})
}
func validRestriction(v Object) bool {
	if !strict(v, []string{"scope", "active", "until", "reason", "revision"}, nil) || v["scope"] != "community-participation" {
		return false
	}
	if _, ok := v["active"].(bool); !ok {
		return false
	}
	if _, ok := number(v["revision"]); !ok {
		return false
	}
	if v["until"] != nil && stamp(v["until"]) == nil {
		return false
	}
	if v["reason"] != nil {
		t, ok := v["reason"].(string)
		if !ok || utf8.RuneCountInString(t) > 2000 {
			return false
		}
	}
	return true
}
func (s *Service) Operation(ctx context.Context, a Actor, id, operation string) (Object, error) {
	if !validID(id) || !validID(operation) {
		return nil, invalid()
	}
	d := s.domain()
	actor, e := s.fresh(ctx, a, "accounts.read")
	if e != nil {
		return nil, e
	}
	if d.IsExecution(actor) {
		return nil, fail("business_admin_denied", 403)
	}
	return postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e = d.Fresh(ctx, tx, actor, "accounts.read"); e != nil {
			return nil, e
		}
		if _, e = s.AccountWithin(ctx, tx, id, false); e != nil {
			return nil, e
		}
		row, e := one(ctx, tx, `SELECT to_jsonb(a) FROM (SELECT operator_id,account_id,action,selection,result,created_at FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2)a`, d.Endpoint, operation)
		if e != nil {
			return nil, e
		}
		out := Object{"operationId": operation, "accountId": id, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30, "metadataOnly": true, "state": "not-recorded", "action": nil, "selection": nil, "result": nil, "recordedAt": nil}
		if row != nil {
			action := str(row["action"])
			if row["operator_id"] != actor.ID || row["account_id"] != id || !slices.Contains([]string{"restriction-set", "restriction-release", "type-change"}, action) {
				return nil, fail("not_found", 404)
			}
			selection, result := obj(row["selection"]), obj(row["result"])
			var input Object
			var err error
			if action == "type-change" {
				input, err = ParseTypeChange(selection)
			} else {
				input, err = ParseRestriction(selection, action == "restriction-release")
			}
			before, after := obj(result["before"]), obj(result["restriction"])
			valid := err == nil && input["operationId"] == operation && result["operationId"] == operation && result["accountId"] == id && stamp(result["recordedAt"]) != nil
			if action == "type-change" {
				valid = valid && strict(result, []string{"accountId", "previousType", "subjectType", "revision", "basisKind", "permissionsChanged", "operationId", "recordedAt"}, nil) && (result["previousType"] == nil || slices.Contains([]string{"person", "organization", "agent"}, str(result["previousType"]))) && result["subjectType"] == input["subjectType"] && num(result["revision"]) == num(input["expectedRevision"])+1 && result["basisKind"] == "operator-recorded-statement" && result["permissionsChanged"] == false
			} else {
				valid = valid && strict(result, []string{"accountId", "before", "restriction", "operationId", "recordedAt"}, nil) && validRestriction(before) && validRestriction(after) && num(before["revision"]) == num(input["expectedRevision"]) && num(after["revision"]) == num(input["expectedRevision"])+1
				if action == "restriction-set" {
					valid = valid && equal(stamp(after["until"]), stamp(input["until"])) && after["active"] == true && after["reason"] == input["reason"]
				} else {
					valid = valid && after["until"] == nil && after["active"] == false && after["reason"] == nil
				}
			}
			if !valid {
				return nil, fail("business_admin_operation_unavailable", 503)
			}
			out["state"], out["action"], out["selection"], out["result"], out["recordedAt"] = "recorded", action, input, result, result["recordedAt"]
		}
		if _, e = d.Fresh(ctx, tx, actor, "accounts.read"); e != nil {
			return nil, e
		}
		return out, nil
	})
}
