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
	if kind == "contributions" {
		account := str(input, "accountId")
		if _, err := uuid.Parse(account); err != nil {
			return nil, invalid()
		}
		limit := int64(50)
		if value, present := input["limit"]; present {
			var valid bool
			limit, valid = integer(value)
			if !valid || limit < 1 || limit > 100 {
				return nil, invalid()
			}
		}
		return s.contributions(ctx, account, int(limit), str(input, "after"), true, func(tx pgx.Tx) error {
			_, err := s.require(ctx, tx, a, "content.read")
			return err
		})
	}
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
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.require(ctx, tx, a, permission)
		if e != nil {
			return nil, e
		}
		if kind == "recognition-save" && ((s.Authority.Duty != nil && s.Authority.Duty.AcceptsDuty(fresh)) || (s.Authority.Execution != nil && s.Authority.Execution.AcceptsExecution(fresh)) || fresh.AIProof != nil) {
			return nil, fault.New("business_admin_denied", 403)
		}
		return s.commandWithin(ctx, tx, fresh, kind, op, input, func() (Object, error) {
			switch kind {
			case "rule-save":
				return s.saveRule(ctx, tx, input)
			case "levels-save":
				return s.saveLevels(ctx, tx, input)
			case "definition-save":
				return s.saveDefinition(ctx, tx, input)
			default:
				return s.saveRecognition(ctx, tx, fresh, input)
			}
		})
	})
}

func (s *Service) operationWithin(ctx context.Context, tx pgx.Tx, a Actor, kind, op, hash string) (Object, error) {
	var oldHash, owner, oldKind string
	var result Object
	err := tx.QueryRow(ctx, `SELECT request_hash,actor_id,kind,result FROM community_growth_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, op).Scan(&oldHash, &owner, &oldKind, &result)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if hash != oldHash || owner != a.ID || kind != oldKind {
		return nil, fault.New("community_growth_operation_conflict", 409)
	}
	return result, nil
}

func (s *Service) commandWithin(ctx context.Context, tx pgx.Tx, a Actor, kind, op string, input Object, apply func() (Object, error)) (Object, error) {
	selection, err := identity.Canonical(input)
	if err != nil {
		return nil, err
	}
	hash := identity.Digest(selection)
	if err = s.ensureDefaults(ctx, tx); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912765))`, s.Endpoint+":"+op); err != nil {
		return nil, err
	}
	old, err := s.operationWithin(ctx, tx, a, kind, op, hash)
	if err != nil {
		return nil, err
	}
	if old != nil {
		old["replayed"] = true
		return old, nil
	}
	result, err := apply()
	if err != nil {
		return nil, err
	}
	result["operationId"] = op
	result["replayed"] = false
	res := jsonText(result)
	at := s.now()
	_, err = tx.Exec(ctx, `INSERT INTO community_growth_operations_v1(endpoint,operation_id,actor_id,kind,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, s.Endpoint, op, a.ID, kind, hash, res, at)
	if err != nil {
		return nil, err
	}
	auditKind := kind
	if kind == experienceAdoption {
		auditKind = "rule-save"
	}
	_, err = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,http_request_id,selection,result,created_at,actor_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'business-operator')`, uuid.NewString(), s.Endpoint, a.ID, a.Role, "community-growth."+auditKind, op, a.RequestID, string(selection), res, at)
	if err != nil {
		return nil, err
	}
	return result, nil
}
