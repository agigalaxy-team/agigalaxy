package operationspermissions

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func parseAICommand(input Object, assignment bool) (Object, error) {
	x := obj(clone(input))
	required := []string{"operationId", "expectedVersion"}
	optional := []string{}
	if assignment {
		required = append(required, "roleId", "enabled")
		optional = append(optional, "id")
	} else {
		required = append(required, "kind")
		optional = append(optional, "reason")
		switch x["kind"] {
		case "profile-save":
			required = append(required, "name", "description")
		case "state-save":
			required = append(required, "enabled")
		default:
			return nil, aiInvalid()
		}
	}
	if !exact(x, required, optional) || !validUUID(x["operationId"]) || !intOK(x["expectedVersion"], 0) {
		return nil, aiInvalid()
	}
	if assignment {
		if !validUUID(x["roleId"]) {
			return nil, aiInvalid()
		}
		if v, ok := x["id"]; ok && !validUUID(v) {
			return nil, aiInvalid()
		}
	}
	if assignment || x["kind"] == "state-save" {
		if _, ok := x["enabled"].(bool); !ok {
			return nil, aiInvalid()
		}
	} else {
		name, ok := text(x["name"], 1, 100, false)
		if !ok {
			return nil, aiInvalid()
		}
		description, ok := text(x["description"], 0, 1000, false)
		if !ok {
			return nil, aiInvalid()
		}
		x["name"], x["description"] = name, description
	}
	if !assignment {
		reason := ""
		if v, ok := x["reason"]; ok {
			r, valid := text(v, 0, 1000, false)
			if !valid {
				return nil, aiInvalid()
			}
			reason = r
		}
		x["reason"] = reason
	}
	return x, nil
}
func (s *Service) aiCurrent(ctx context.Context, tx pgx.Tx, actor Actor, action string) (Actor, error) {
	a, e := s.require(ctx, tx, actor, "ai.accounts.read")
	if e != nil {
		return Actor{}, e
	}
	return s.require(ctx, tx, a, action)
}
func (s *Service) aiExisting(ctx context.Context, tx pgx.Tx, actor Actor, domain, kind string, x Object) (Object, error) {
	r, e := one(ctx, tx, "SELECT to_jsonb(c) FROM operations_ai_work_commands_v1 c WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, x["operationId"])
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	reason := str(x["reason"])
	if r["operator_id"] != actor.ID || r["domain"] != domain || r["kind"] != kind || !same(r["selection"], aiSelection(kind, x)) || str(r["reason"]) != reason {
		return nil, fail("operations_ai_work_operation_conflict", 409)
	}
	out, e := aiReceipt(r, true)
	if e != nil {
		return nil, e
	}
	at := s.now()
	out["checkedAt"], out["readExpiresAt"], out["metadataOnly"] = at, at+30, true
	return out, nil
}
func (s *Service) aiRecord(ctx context.Context, tx pgx.Tx, actor Actor, domain, kind string, x, result Object) (Object, error) {
	at := time.Unix(s.now(), 0)
	account := obj(result["account"])
	r, e := one(ctx, tx, `INSERT INTO operations_ai_work_commands_v1(endpoint,operation_id,ai_account_id,domain,operator_id,kind,selection,result,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING to_jsonb(operations_ai_work_commands_v1)`, s.Endpoint, x["operationId"], account["id"], domain, actor.ID, kind, jsonText(aiSelection(kind, x)), jsonText(result), str(x["reason"]), at)
	if e != nil {
		return nil, e
	}
	auditResult := Object{"kind": kind, "version": account["version"], "enabled": account["enabled"]}
	if result["assignment"] != nil {
		a := obj(result["assignment"])
		auditResult["assignmentId"], auditResult["assignmentVersion"], auditResult["assignmentEnabled"] = a["id"], a["version"], a["enabled"]
	}
	_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context) VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,'business-operator',NULL,NULL,NULL)`, uuid.NewString(), s.Endpoint, actor.ID, actor.Role, "ai-work-"+kind, x["operationId"], actor.RequestID, jsonText(Object{"id": account["id"], "domain": domain}), jsonText(auditResult), at)
	if e != nil {
		return nil, e
	}
	receipt, e := aiReceipt(r, false)
	if e != nil {
		return nil, e
	}
	checked := s.now()
	receipt["checkedAt"], receipt["readExpiresAt"], receipt["metadataOnly"] = checked, checked+30, true
	return receipt, nil
}
func (s *Service) AIWorkCommand(ctx context.Context, actor Actor, domain string, input Object) (Object, error) {
	if !contains(operationsai.Domains, domain) {
		return nil, aiInvalid()
	}
	x, e := parseAICommand(input, false)
	if e != nil {
		return nil, e
	}
	action := "ai.accounts.profile.write"
	if x["kind"] == "state-save" {
		action = "ai.accounts.state.write"
	}
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.aiCurrent(ctx, tx, actor, action) }); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))", s.Endpoint); e != nil {
			return nil, e
		}
		fresh, e := s.aiCurrent(ctx, tx, actor, action)
		if e != nil {
			return nil, e
		}
		if replay, e := s.aiExisting(ctx, tx, fresh, domain, str(x["kind"]), x); e != nil || replay != nil {
			return replay, e
		}
		row, e := s.aiAccountDomain(ctx, tx, domain, true)
		if e != nil {
			return nil, e
		}
		if num(row["version"]) != num(x["expectedVersion"]) {
			return nil, fail("operations_ai_work_version_changed", 409)
		}
		var next Object
		if x["kind"] == "profile-save" {
			next, e = one(ctx, tx, "UPDATE operations_ai_work_accounts_v1 SET name=$3,description=$4,version=version+1,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_ai_work_accounts_v1)", s.Endpoint, row["id"], x["name"], x["description"], time.Unix(s.now(), 0))
		} else {
			next, e = one(ctx, tx, "UPDATE operations_ai_work_accounts_v1 SET enabled=$3,version=version+1,authorization_version=authorization_version+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_ai_work_accounts_v1)", s.Endpoint, row["id"], x["enabled"], time.Unix(s.now(), 0))
		}
		if e != nil {
			return nil, e
		}
		if _, e = s.aiCurrent(ctx, tx, actor, action); e != nil {
			return nil, e
		}
		return s.aiRecord(ctx, tx, fresh, domain, str(x["kind"]), x, Object{"account": aiAccountView(next)})
	})
}
func (s *Service) AIWorkAssignment(ctx context.Context, actor Actor, domain string, input Object) (Object, error) {
	if !contains(operationsai.Domains, domain) {
		return nil, aiInvalid()
	}
	x, e := parseAICommand(input, true)
	if e != nil {
		return nil, e
	}
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.aiCurrent(ctx, tx, actor, "ai.accounts.roles.write") }); e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))", s.Endpoint); e != nil {
			return nil, e
		}
		fresh, e := s.aiCurrent(ctx, tx, actor, "ai.accounts.roles.write")
		if e != nil {
			return nil, e
		}
		if replay, e := s.aiExisting(ctx, tx, fresh, domain, "assignment-save", x); e != nil || replay != nil {
			return replay, e
		}
		account, e := s.aiAccountDomain(ctx, tx, domain, true)
		if e != nil {
			return nil, e
		}
		old, e := one(ctx, tx, "SELECT to_jsonb(a) FROM operations_ai_work_assignments_v1 a WHERE endpoint=$1 AND ai_account_id=$2 AND role_id=$3", s.Endpoint, account["id"], x["roleId"])
		old, e = optionalRow(old, e)
		if e != nil {
			return nil, e
		}
		if x["id"] != nil {
			if old == nil || old["id"] != x["id"] || num(old["version"]) != num(x["expectedVersion"]) {
				return nil, fail("operations_ai_work_assignment_changed", 409)
			}
		} else if old != nil || num(x["expectedVersion"]) != 0 || x["enabled"] != true {
			return nil, fail("operations_ai_work_assignment_changed", 409)
		}
		role, e := one(ctx, tx, "SELECT to_jsonb(r) FROM operations_business_roles_v1 r WHERE endpoint=$1 AND id=$2", s.Endpoint, x["roleId"])
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fail("operations_role_not_found", 404)
		}
		if e != nil {
			return nil, e
		}
		if x["enabled"] == true {
			if role["enabled"] != true {
				return nil, fail("operations_ai_work_role_denied", 403)
			}
			for _, p := range stringsOf(role["permissions"]) {
				if !known(p) || !contains(fresh.Permissions, p) {
					return nil, fail("operations_ai_work_role_denied", 403)
				}
			}
		}
		at := time.Unix(s.now(), 0)
		if old != nil {
			_, e = tx.Exec(ctx, "UPDATE operations_ai_work_assignments_v1 SET enabled=$3,version=version+1,updated_at=$4 WHERE endpoint=$1 AND id=$2", s.Endpoint, old["id"], x["enabled"], at)
		} else {
			_, e = tx.Exec(ctx, "INSERT INTO operations_ai_work_assignments_v1(id,endpoint,ai_account_id,role_id,enabled,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,1,$6,$6)", uuid.NewString(), s.Endpoint, account["id"], x["roleId"], x["enabled"], at)
		}
		if e != nil {
			return nil, e
		}
		next, e := one(ctx, tx, "UPDATE operations_ai_work_accounts_v1 SET version=version+1,authorization_version=authorization_version+1,updated_at=$3 WHERE endpoint=$1 AND id=$2 RETURNING to_jsonb(operations_ai_work_accounts_v1)", s.Endpoint, account["id"], at)
		if e != nil {
			return nil, e
		}
		assignments, e := s.aiAssignments(ctx, tx, str(account["id"]))
		if e != nil {
			return nil, e
		}
		var assignment Object
		for _, v := range assignments {
			if obj(v)["roleId"] == x["roleId"] {
				assignment = obj(v)
				break
			}
		}
		if assignment == nil {
			return nil, fail("operations_ai_work_receipt_unavailable", 503)
		}
		if _, e = s.aiCurrent(ctx, tx, actor, "ai.accounts.roles.write"); e != nil {
			return nil, e
		}
		return s.aiRecord(ctx, tx, fresh, domain, "assignment-save", x, Object{"account": aiAccountView(next), "assignment": assignment})
	})
}
