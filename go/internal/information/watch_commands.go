package information

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Watches) Command(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	x, e := parseWatch(raw, "command")
	if e != nil {
		return nil, e
	}
	hash, e := Digest(x)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, one(x["action"], "pause", "end"), func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		prior, e := query(ctx, tx, `SELECT subject_id,request_hash,result FROM information_watch_operations_v2 WHERE operation_id=$1`, x["operationId"])
		if e != nil {
			return nil, e
		}
		if len(prior) > 0 {
			r := prior[0]
			if r["subject_id"] != a.SubjectID || r["request_hash"] != hash {
				return nil, fault.New("information_operation_conflict", 409)
			}
			result := copyObject(obj(r["result"]))
			result["replayed"] = true
			return result, nil
		}
		if !one(x["action"], "pause", "end") && s.CanProcessEvidence != nil && !s.CanProcessEvidence() {
			return nil, fault.New("service_writes_stopped", 410)
		}
		if plan := obj(x["plan"]); plan != nil {
			if number(plan, "expiresAt") <= s.now() {
				return nil, fault.New("information_watch_expired", 409)
			}
			for _, v := range list(plan["sources"]) {
				source := obj(obj(v)["source"])
				if !contains(auth.CredentialScopes, Scope(source)) {
					return nil, fault.New("information_source_scope_required", 403)
				}
				if source["kind"] != "reference" {
					q := obj(source["request"])
					if source["kind"] != "honor" {
						q = obj(q["query"])
					}
					if text(q, "after") != "" {
						return nil, fault.New("watch_scope_must_start_at_source_beginning", 400)
					}
				}
			}
		}
		var r Object
		if x["action"] == "start" {
			if number(x, "expectedRevision") != 0 {
				return nil, fault.New("information_watch_revision_conflict", 409)
			}
			var count int64
			if e = tx.QueryRow(ctx, `SELECT count(*) FROM information_watches_v2 WHERE subject_id=$1 AND state<>'ended' AND expires_at>$2`, a.SubjectID, s.at(s.now())).Scan(&count); e != nil {
				return nil, e
			}
			if count >= 20 {
				return nil, fault.New("information_watch_limit", 429)
			}
			plan := obj(x["plan"])
			tag, e := tx.Exec(ctx, `INSERT INTO information_watches_v2(id,subject_id,revision,state,plan,expires_at,created_at,updated_at,next_check_at) VALUES($1,$2,1,'active',$3::jsonb,$4,$5,$5,$5) ON CONFLICT DO NOTHING`, x["watchId"], a.SubjectID, string(encode(plan)), s.at(number(plan, "expiresAt")), s.at(s.now()))
			if e != nil {
				return nil, e
			}
			if tag.RowsAffected() != 1 {
				return nil, fault.New("information_watch_exists", 409)
			}
			r, e = s.rowWithin(ctx, tx, a, text(x, "watchId"), true)
			if e != nil {
				return nil, e
			}
		} else {
			r, e = s.rowWithin(ctx, tx, a, text(x, "watchId"), true)
			if e != nil {
				return nil, e
			}
			if number(r, "revision") != number(x, "expectedRevision") {
				return nil, fault.New("information_watch_revision_conflict", 409)
			}
			if r["state"] == "ended" {
				return nil, fault.New("information_watch_ended", 409)
			}
			if x["action"] == "resume" && seconds(r["expires_at"]) <= s.now() {
				return nil, fault.New("information_watch_expired", 409)
			}
			state := r["state"]
			switch x["action"] {
			case "end":
				state = "ended"
			case "pause":
				state = "paused"
			case "resume":
				state = "active"
			}
			plan := obj(x["plan"])
			if plan == nil {
				plan = obj(r["plan"])
			}
			if _, e = tx.Exec(ctx, `UPDATE information_watches_v2 SET revision=revision+1,state=$3,plan=$4::jsonb,expires_at=$5,updated_at=$6,ended_at=CASE WHEN $3='ended' THEN $6 ELSE ended_at END,next_check_at=$6,baseline=CASE WHEN $7 THEN '{}'::jsonb ELSE baseline END,scan=CASE WHEN $7 THEN '{}'::jsonb ELSE scan END WHERE id=$1 AND subject_id=$2`, x["watchId"], a.SubjectID, state, string(encode(plan)), s.at(number(plan, "expiresAt")), s.at(s.now()), x["action"] == "revise"); e != nil {
				return nil, e
			}
			r, e = s.rowWithin(ctx, tx, a, text(x, "watchId"), false)
			if e != nil {
				return nil, e
			}
		}
		if one(x["action"], "start", "revise", "resume") {
			required := []string{"notifications"}
			for _, v := range list(obj(r["plan"])["sources"]) {
				scope := Scope(obj(obj(v)["source"]))
				if !contains(required, scope) {
					required = append(required, scope)
				}
			}
			for _, scope := range required {
				if !contains(auth.CredentialScopes, scope) {
					return nil, fault.New("information_source_scope_required", 403)
				}
			}
			authority := Object{"bindingId": a.BindingID, "scopes": required, "deviceId": auth.DeviceID, "keyId": auth.KeyID, "controlEpoch": auth.Epoch}
			if _, e = tx.Exec(ctx, `UPDATE information_watches_v2 SET background_authority=$2::jsonb,background_state='scheduled',background_error=NULL WHERE id=$1`, r["id"], string(encode(authority))); e != nil {
				return nil, e
			}
		} else {
			if _, e = tx.Exec(ctx, `UPDATE information_watches_v2 SET background_state=$2 WHERE id=$1`, r["id"], r["state"]); e != nil {
				return nil, e
			}
		}
		r, e = s.rowWithin(ctx, tx, a, text(r, "id"), false)
		if e != nil {
			return nil, e
		}
		if e = s.queueWithin(ctx, tx, r); e != nil {
			return nil, e
		}
		result := merge(Object{"operationId": x["operationId"], "watchId": x["watchId"], "revision": r["revision"], "state": s.view(r)["state"], "requestHash": hash}, s.runtime(r))
		if _, e = tx.Exec(ctx, `INSERT INTO information_watch_operations_v2(operation_id,subject_id,watch_id,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, x["operationId"], a.SubjectID, x["watchId"], hash, string(encode(result)), s.at(s.now())); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, text(x, "watchId"), text(x, "operationId"), requestID); e != nil {
			return nil, e
		}
		return result, nil
	})
}
func (s *Watches) Stop(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	var x Object
	if protocol.Decode(raw, &x) != nil || !one(x["action"], "pause", "end") {
		return nil, fault.New("invalid_information_stop", 400)
	}
	return s.Command(ctx, a, raw, requestID)
}
func (s *Watches) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parseWatch(raw, "receipt")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, `SELECT request_hash,result FROM information_watch_operations_v2 WHERE operation_id=$1 AND subject_id=$2`, x["operationId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if len(rows) == 0 {
			return Object{"state": "absent"}, nil
		}
		if rows[0]["request_hash"] != x["requestHash"] {
			return Object{"state": "conflict"}, nil
		}
		return Object{"state": "acknowledged", "result": rows[0]["result"]}, nil
	})
}
func (s *Watches) List(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parseWatch(raw, "list")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		if id := text(x, "watchId"); id != "" {
			r, e := s.rowWithin(ctx, tx, a, id, false)
			if e != nil {
				return nil, e
			}
			return merge(Object{"items": []any{s.view(r)}, "nextAfter": nil}, s.runtime(nil)), nil
		}
		rows, e := query(ctx, tx, `SELECT `+watchColumns+` FROM information_watches_v2 WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) AND (NOT $4::boolean OR state='active' AND expires_at>$5) ORDER BY id LIMIT $3`, a.SubjectID, x["after"], number(x, "limit")+1, x["activeOnly"], s.at(s.now()))
		if e != nil {
			return nil, e
		}
		limit := int(number(x, "limit"))
		more := len(rows) > limit
		if more {
			rows = rows[:limit]
		}
		items := []any{}
		for _, r := range rows {
			r, e := decodeWatch(r)
			if e != nil {
				return nil, e
			}
			items = append(items, s.view(r))
		}
		var next any
		if more {
			next = rows[len(rows)-1]["id"]
		}
		return merge(Object{"items": items, "nextAfter": next}, s.runtime(nil)), nil
	})
}
