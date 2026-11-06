package communitygrowth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) Query(ctx context.Context, a Actor, input Object) (Object, error) {
	kind := str(input, "kind")
	permission := "rules.read"
	if kind == "recognitions" {
		permission = "content.read"
	}
	if kind != "rules" && kind != "definitions" && kind != "recognitions" {
		return nil, invalid()
	}
	limit := int64(50)
	var after *cursor
	if kind == "recognitions" {
		if v, ok := input["limit"]; ok {
			var valid bool
			limit, valid = integer(v)
			if !valid || limit < 1 || limit > 100 {
				return nil, invalid()
			}
		}
		if v, ok := input["after"]; ok {
			value, valid := v.(string)
			if !valid || value == "" || len(value) > 512 {
				return nil, invalid()
			}
			raw, e := base64.RawURLEncoding.DecodeString(value)
			var c cursor
			if e != nil || json.Unmarshal(raw, &c) != nil || c.At.IsZero() {
				return nil, invalid()
			}
			if _, e = uuid.Parse(c.ID); e != nil {
				return nil, invalid()
			}
			after = &c
		}
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.require(ctx, tx, a, permission); e != nil {
			if kind != "definitions" || fault.Status(e) != 403 {
				return nil, e
			}
			if _, e = s.require(ctx, tx, a, "content.read"); e != nil {
				return nil, e
			}
		}
		if e := s.ensureDefaults(ctx, tx); e != nil {
			return nil, e
		}
		var q string
		var args []any
		switch kind {
		case "rules":
			q = `SELECT jsonb_build_object('ruleKey',rule_key,'sourceKind',source_kind,'label',label,'experience',experience,'enabled',enabled,'version',version) FROM community_growth_rules_v1 WHERE endpoint=$1 ORDER BY rule_key`
			args = []any{s.Endpoint}
		case "definitions":
			q = `SELECT jsonb_build_object('id',id,'name',name,'description',description,'enabled',enabled,'version',version) FROM community_growth_definitions_v1 WHERE endpoint=$1 ORDER BY name,id`
			args = []any{s.Endpoint}
		case "recognitions":
			if _, e := uuid.Parse(str(input, "accountId")); e != nil {
				return nil, invalid()
			}
			q = `SELECT jsonb_build_object('id',id,'kind',kind,'accountId',account_id,'definitionId',definition_id,'objectKind',object_kind,'objectId',object_id,'domain',domain,'reason',reason,'active',active,'revision',revision,'issuedBy',issued_by,'updatedBy',updated_by,'createdAt',created_at,'updatedAt',updated_at) FROM community_growth_recognitions_v1 WHERE endpoint=$1 AND account_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`
			var at, id any
			if after != nil {
				at = after.At
				id = after.ID
			}
			args = []any{s.Endpoint, str(input, "accountId"), at, id, limit + 1}
		}
		rows, e := tx.Query(ctx, q, args...)
		if e != nil {
			return nil, e
		}
		items, e := rowsObjects(rows)
		if e != nil {
			return nil, e
		}
		out := Object{"items": items}
		if kind == "recognitions" {
			var next any
			if len(items) > int(limit) {
				items = items[:int(limit)]
				last := items[len(items)-1]
				at, e := time.Parse(time.RFC3339Nano, str(last, "createdAt"))
				if e != nil {
					return nil, e
				}
				raw, e := json.Marshal(cursor{At: at, ID: str(last, "id")})
				if e != nil {
					return nil, e
				}
				next = base64.RawURLEncoding.EncodeToString(raw)
			}
			out["items"] = items
			out["nextCursor"] = next
		}
		if kind == "rules" {
			rows, e = tx.Query(ctx, `SELECT jsonb_build_object('level',level,'minimum',minimum,'label',label) FROM community_growth_levels_v1 WHERE endpoint=$1 ORDER BY minimum`, s.Endpoint)
			if e != nil {
				return nil, e
			}
			levels, e := rowsObjects(rows)
			if e != nil {
				return nil, e
			}
			out["levels"] = levels
			var levelVersion int64
			if e = tx.QueryRow(ctx, `SELECT levels_version FROM community_growth_initialized_v1 WHERE endpoint=$1`, s.Endpoint).Scan(&levelVersion); e != nil {
				return nil, e
			}
			out["levelsVersion"] = levelVersion
		}
		return out, nil
	})
}
func (s *Service) Receipt(ctx context.Context, a Actor, input Object) (Object, error) {
	op := str(input, "operationId")
	if _, e := uuid.Parse(op); e != nil {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if s.Authority == nil {
			return nil, fault.New("operations_authorization_unavailable", 503)
		}
		if a.ID == "" || a.Endpoint != s.Endpoint {
			return nil, fault.New("business_admin_denied", 403)
		}
		fresh, e := s.Authority.EffectiveWithin(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint {
			return nil, fault.New("business_admin_denied", 403)
		}
		var actor, kind string
		var result Object
		e = tx.QueryRow(ctx, `SELECT actor_id,kind,result FROM community_growth_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, op).Scan(&actor, &kind, &result)
		if noRows(e) {
			return Object{"state": "not-recorded", "operationId": op}, nil
		}
		if e != nil {
			return nil, e
		}
		permission := "rules.read"
		if kind == "recognition-save" {
			permission = "content.read"
		}
		if _, e = s.require(ctx, tx, a, permission); e != nil {
			return nil, e
		}
		return Object{"state": "recorded", "operationId": op, "result": result}, nil
	})
}
func (s *Service) Command(ctx context.Context, a Actor, input Object) (Object, error) {
	kind, op := str(input, "kind"), str(input, "operationId")
	if _, e := uuid.Parse(op); e != nil {
		return nil, invalid()
	}
	permission := "rules.write"
	if kind == "recognition-save" {
		permission = "content.curate"
	}
	if kind != "rule-save" && kind != "levels-save" && kind != "definition-save" && kind != "recognition-save" {
		return nil, invalid()
	}
	b, e := identity.Canonical(input)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(b)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.require(ctx, tx, a, permission)
		if e != nil {
			return nil, e
		}
		if kind == "recognition-save" && ((s.Authority.Duty != nil && s.Authority.Duty.AcceptsDuty(fresh)) || (s.Authority.Execution != nil && s.Authority.Execution.AcceptsExecution(fresh)) || fresh.AIProof != nil) {
			return nil, fault.New("business_admin_denied", 403)
		}
		if e = s.ensureDefaults(ctx, tx); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912765))`, s.Endpoint+":"+op); e != nil {
			return nil, e
		}
		var oldHash, owner string
		var old Object
		e = tx.QueryRow(ctx, `SELECT request_hash,actor_id,result FROM community_growth_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, op).Scan(&oldHash, &owner, &old)
		if e == nil {
			if hash != oldHash || owner != fresh.ID {
				return nil, fault.New("community_growth_operation_conflict", 409)
			}
			old["replayed"] = true
			return old, nil
		}
		if !noRows(e) {
			return nil, e
		}
		var result Object
		switch kind {
		case "rule-save":
			result, e = s.saveRule(ctx, tx, input)
		case "levels-save":
			result, e = s.saveLevels(ctx, tx, input)
		case "definition-save":
			result, e = s.saveDefinition(ctx, tx, input)
		case "recognition-save":
			result, e = s.saveRecognition(ctx, tx, fresh, input)
		}
		if e != nil {
			return nil, e
		}
		result["operationId"] = op
		result["replayed"] = false
		_, e = tx.Exec(ctx, `INSERT INTO community_growth_operations_v1(endpoint,operation_id,actor_id,kind,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, s.Endpoint, op, fresh.ID, kind, hash, jsonText(result), s.now())
		if e != nil {
			return nil, e
		}
		selection, _ := json.Marshal(input)
		res, _ := json.Marshal(result)
		_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,http_request_id,selection,result,created_at,actor_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'business-operator')`, uuid.NewString(), s.Endpoint, fresh.ID, fresh.Role, "community-growth."+kind, op, fresh.RequestID, selection, res, s.now())
		if e != nil {
			return nil, e
		}
		return result, nil
	})
}
