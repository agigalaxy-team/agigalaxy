package accountarchive

import (
	"context"
	"unicode/utf16"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func workAbsent(a Actor, id string) Object {
	return Object{"accountId": a.AccountID, "workId": id, "state": "absent", "revision": 0, "scopeId": nil, "lastOperationId": nil, "audience": "owner-only"}
}
func workView(r Object, data, preview bool) Object {
	out := Object{"accountId": r["account_id"], "workId": r["work_id"], "originSubjectId": r["origin_subject_id"], "scopeId": r["scope_id"], "state": r["state"], "revision": r["revision"], "lastOperationId": r["last_operation_id"], "uploadLevel": r["upload_level"], "storedAt": date(r["updated_at"]), "audience": "owner-only", "completeConversation": false}
	d, _ := r["data"].(map[string]any)
	for _, k := range []string{"startedAt", "updatedAt"} {
		if v, ok := d[k]; ok {
			out[k] = v
		}
	}
	if preview && d != nil {
		source, _ := d["source"].(map[string]any)
		out["workType"] = d["workType"]
		out["role"] = d["role"]
		out["sourceHost"] = source["host"]
		out["resultStatus"] = d["resultStatus"]
		if r["state"] == "stored" && (r["upload_level"] == "work-content" || r["upload_level"] == "conversation-archive") {
			if summary, ok := d["summary"].(map[string]any); ok {
				out["title"] = summary["title"]
				u := utf16.Encode([]rune(str(summary, "summary")))
				if len(u) > 240 {
					u = u[:240]
				}
				out["preview"] = string(utf16.Decode(u))
			}
		}
	}
	if r["state"] == "deleted" {
		out["deletedAt"] = date(r["deleted_at"])
		out["deletedReason"] = "owner-deleted"
	}
	if data {
		out["data"] = r["data"]
	}
	return out
}
func workHead(ctx context.Context, tx pgx.Tx, a Actor, id string, lock bool) (Object, error) {
	sql := `SELECT * FROM account_work_v1 WHERE account_id=$1 AND work_id=$2`
	if lock {
		sql += " FOR UPDATE"
	}
	r, e := row(ctx, tx, sql, a.AccountID, id)
	if e != nil {
		return nil, e
	}
	if r != nil && !a.Official && r["origin_subject_id"] != a.Device.SubjectID {
		return nil, nil
	}
	return r, nil
}
func (s *Service) Work(ctx context.Context, a Actor, action string, raw []byte) (Object, error) {
	if action != "put" && action != "get" && action != "status" && action != "list" && action != "delete" {
		return nil, fault.New("not_found", 404)
	}
	p, e := parseWork(raw, action)
	if e != nil {
		return nil, e
	}
	id := str(p, "workId")
	if action == "put" {
		if a.Official {
			return nil, fault.New("access_denied", 401)
		}
		if p["data"].(map[string]any)["galaxyId"] != a.Device.SubjectID {
			return nil, fault.New("account_work_source_mismatch", 403)
		}
	}
	return s.run(ctx, a, action == "put" || action == "delete", action == "put", func(tx pgx.Tx, a Actor) (Object, error) {
		if action == "list" {
			limit := int64(20)
			if _, ok := p["limit"]; ok {
				limit, _ = number(p["limit"])
			}
			rr, e := rows(ctx, tx, `SELECT * FROM account_work_v1 WHERE account_id=$1 AND state='stored' AND ($2::text IS NULL OR origin_subject_id=$2) AND ($3::text IS NULL OR work_id>$3) ORDER BY work_id LIMIT $4`, a.AccountID, origin(a), p["after"], limit+1)
			if e != nil {
				return nil, e
			}
			out := []Object{}
			var next any
			for i, r := range rr {
				if int64(i) == limit {
					next = rr[i-1]["work_id"]
					break
				}
				out = append(out, workView(r, false, true))
			}
			return Object{"accountId": a.AccountID, "items": out, "nextAfter": next, "audience": "owner-only"}, nil
		}
		if action == "put" {
			return s.put(ctx, tx, a, p)
		}
		r, e := workHead(ctx, tx, a, id, action == "delete")
		if e != nil {
			return nil, e
		}
		if r == nil {
			out := workAbsent(a, id)
			if action == "get" {
				out["data"] = nil
			}
			if action == "delete" {
				out["localOriginalsAffected"] = false
			}
			return out, nil
		}
		if action != "delete" {
			return workView(r, action == "get", false), nil
		}
		if r["state"] != "deleted" {
			kind := "identity"
			subject := origin(a)
			if a.Official {
				kind = "official-account"
			}
			request := a.RequestID
			if request == "" {
				request = uuid.NewString()
			}
			_, e = tx.Exec(ctx, `UPDATE account_work_scopes_v1 SET deleted_at=$3,deleted_reason='owner-deleted',deleted_by_kind=$4,deleted_by_subject_id=$5,deleted_request_id=$6 WHERE account_id=$1 AND work_id=$2 AND deleted_at IS NULL`, a.AccountID, id, s.now(), kind, subject, request)
			if e != nil {
				return nil, e
			}
			r, e = row(ctx, tx, `UPDATE account_work_v1 SET state='deleted',revision=revision+1,data=NULL,deleted_at=$3,updated_at=$3 WHERE account_id=$1 AND work_id=$2 RETURNING *`, a.AccountID, id, s.now())
			if e != nil {
				return nil, e
			}
		}
		out := workView(r, false, false)
		out["localOriginalsAffected"] = false
		return out, nil
	})
}
func (s *Service) put(ctx context.Context, tx pgx.Tx, a Actor, p Object) (Object, error) {
	canonical, e := identity.Canonical(p)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(canonical)
	existing, e := row(ctx, tx, `SELECT * FROM account_work_v1 WHERE account_id=$1 AND work_id=$2 FOR UPDATE`, a.AccountID, p["workId"])
	if e != nil {
		return nil, e
	}
	if existing != nil && existing["origin_subject_id"] != a.Device.SubjectID {
		return nil, fault.New("account_work_source_mismatch", 403)
	}
	scope, e := row(ctx, tx, `SELECT * FROM account_work_scopes_v1 WHERE account_id=$1 AND scope_id=$2`, a.AccountID, p["scopeId"])
	if e != nil {
		return nil, e
	}
	if scope != nil && (scope["origin_subject_id"] != a.Device.SubjectID || scope["work_id"] != p["workId"]) {
		return nil, fault.New("account_work_scope_mismatch", 409)
	}
	prior, e := row(ctx, tx, `SELECT * FROM account_work_operations_v1 WHERE account_id=$1 AND operation_id=$2`, a.AccountID, p["operationId"])
	if e != nil {
		return nil, e
	}
	if prior != nil && (prior["origin_subject_id"] != a.Device.SubjectID || prior["request_hash"] != hash) {
		return nil, fault.New("account_work_operation_conflict", 409)
	}
	if scope != nil && scope["deleted_at"] != nil {
		return nil, fault.New("account_work_owner_deleted", 410)
	}
	if prior != nil {
		out := prior["receipt"].(map[string]any)
		out["duplicate"] = true
		return out, nil
	}
	if scope != nil && (existing == nil || existing["scope_id"] != p["scopeId"]) {
		return nil, fault.New("account_work_scope_changed", 409)
	}
	revision := int64(0)
	if existing != nil {
		revision, _ = number(existing["revision"])
	}
	expected, _ := number(p["expectedRevision"])
	if revision != expected {
		return nil, fault.New("account_work_revision_conflict", 409)
	}
	if existing != nil && existing["state"] == "deleted" && existing["scope_id"] == p["scopeId"] {
		return nil, fault.New("account_work_owner_deleted", 410)
	}
	if scope == nil {
		_, e = tx.Exec(ctx, `INSERT INTO account_work_scopes_v1(account_id,scope_id,work_id,origin_subject_id,created_at) VALUES($1,$2,$3,$4,$5)`, a.AccountID, p["scopeId"], p["workId"], a.Device.SubjectID, s.now())
		if e != nil {
			return nil, e
		}
	}
	data := p["data"].(map[string]any)
	rev, _ := number(p["revision"])
	r, e := row(ctx, tx, `INSERT INTO account_work_v1(account_id,work_id,origin_subject_id,scope_id,revision,state,upload_level,data,last_operation_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'stored',$6,$7::jsonb,$8,$9,$9) ON CONFLICT(account_id,work_id) DO UPDATE SET scope_id=EXCLUDED.scope_id,revision=EXCLUDED.revision,state='stored',upload_level=EXCLUDED.upload_level,data=EXCLUDED.data,last_operation_id=EXCLUDED.last_operation_id,updated_at=EXCLUDED.updated_at,deleted_at=NULL RETURNING *`, a.AccountID, p["workId"], a.Device.SubjectID, p["scopeId"], rev, data["uploadLevel"], string(encoded(data)), p["operationId"], s.now())
	if e != nil {
		return nil, e
	}
	receipt := workView(r, false, false)
	receipt["operationId"] = p["operationId"]
	receipt["acceptedRevision"] = rev
	receipt["duplicate"] = false
	var request any
	if a.RequestID != "" {
		request = a.RequestID
	}
	_, e = tx.Exec(ctx, `INSERT INTO account_work_operations_v1(account_id,operation_id,work_id,scope_id,origin_subject_id,request_hash,receipt,created_at,origin_binding_id,origin_device_id,origin_key_id,http_request_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`, a.AccountID, p["operationId"], p["workId"], p["scopeId"], a.Device.SubjectID, hash, string(encoded(receipt)), s.now(), a.Device.BindingID, a.Device.DeviceID, a.Device.KeyID, request)
	return receipt, e
}
