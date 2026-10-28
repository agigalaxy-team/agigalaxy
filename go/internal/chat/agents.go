package chat

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) binding(ctx context.Context, tx pgx.Tx, id, subject string) (Object, error) {
	if s.Devices == nil {
		return nil, fail("chat_authority_unavailable", 503)
	}
	return s.Devices.BindingControlWithin(ctx, tx, id, subject, "binding")
}
func (s *Service) GrantAgent(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	x, e := loose(raw)
	if e != nil {
		return nil, e
	}
	if _, ok := x["mode"]; !ok {
		x["mode"] = "read"
	}
	if _, ok := x["primaryResponder"]; !ok {
		x["primaryResponder"] = false
	}
	if _, ok := x["primaryResponder"].(bool); !ok || !validID(str(x, "grantId")) || !validID(str(x, "bindingId")) || !has([]string{"read", "draft", "respond"}, str(x, "mode")) || truth(x, "primaryResponder") && str(x, "mode") != "respond" || !normalizeInteger(x, "expiresAt", s.now().Unix()+1, s.now().Unix()+30*86400) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, true)
		if e != nil {
			return nil, e
		}
		if _, e = s.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		if has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
			return nil, fail("chat_room_read_only")
		}
		ref, _ := actorRef(a)
		b, e := s.binding(ctx, tx, str(x, "bindingId"), ref)
		if e != nil {
			return nil, e
		}
		if b == nil || !has(bindingScopes(b), "binding") || b["revoked_at"] != nil || millis(b["expires_at"]) <= s.now().UnixMilli() {
			return nil, fail("chat_agent_not_authorized", 403)
		}
		if truth(x, "primaryResponder") {
			party := ""
			for _, m := range c.Members {
				if str(m, "subject_id") == ref {
					party = str(m, "controller_ref")
				}
			}
			ids := []string{}
			for _, m := range c.Members {
				if str(m, "controller_ref") == party {
					ids = append(ids, str(m, "subject_id"))
				}
			}
			if _, e = tx.Exec(ctx, "UPDATE chat_agent_grants SET primary_responder=false WHERE room_id=$1 AND subject_id=ANY($2::text[]) AND revoked_at IS NULL", room, ids); e != nil {
				return nil, e
			}
		}
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM chat_agent_grants WHERE grant_id=$1)", x["grantId"]).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fail("chat_grant_exists")
		}
		if _, e = tx.Exec(ctx, `INSERT INTO chat_agent_grants(grant_id,room_id,subject_id,binding_id,mode,primary_responder,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, x["grantId"], room, ref, x["bindingId"], x["mode"], x["primaryResponder"], time.Unix(num(x, "expiresAt"), 0), s.now()); e != nil {
			return nil, e
		}
		return Object{"grantId": x["grantId"], "mode": x["mode"], "primaryResponder": x["primaryResponder"], "expiresAt": x["expiresAt"], "hostRuntimeStarted": false}, nil
	})
}
func bindingScopes(b Object) []string {
	if values, ok := b["scopes"].([]string); ok {
		return values
	}
	return uniqueStrings(b["scopes"])
}
func (s *Service) grantState(ctx context.Context, tx pgx.Tx, c roomContext, r Object) (string, error) {
	b, e := s.binding(ctx, tx, str(r, "binding_id"), str(r, "subject_id"))
	if e != nil {
		return "", e
	}
	if r["revoked_at"] != nil {
		return "revoked", nil
	}
	if millis(r["expires_at"]) <= s.now().UnixMilli() {
		return "expired", nil
	}
	if b == nil || b["revoked_at"] != nil || !has(bindingScopes(b), "binding") || millis(b["expires_at"]) <= s.now().UnixMilli() {
		return "binding-unavailable", nil
	}
	if has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
		return "room-inactive", nil
	}
	return "active", nil
}
func (s *Service) QueryAgentGrants(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	x, e := parsePage(raw)
	if e != nil {
		return nil, e
	}
	if str(x, "after") != "" && !validID(str(x, "after")) || str(x, "grantId") != "" && !validID(str(x, "grantId")) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, false)
		if e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		rr, e := rows(ctx, tx, "SELECT to_jsonb(g) FROM chat_agent_grants g WHERE room_id=$1 AND subject_id=$2 AND ($3='' OR grant_id::text>$3) AND ($4::uuid IS NULL OR grant_id=$4) ORDER BY grant_id LIMIT $5", room, ref, str(x, "after"), x["grantId"], num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for i, r := range rr {
			if int64(i) >= num(x, "limit") {
				break
			}
			state, e := s.grantState(ctx, tx, c, r)
			if e != nil {
				return nil, e
			}
			items = append(items, Object{"grantId": r["grant_id"], "roomId": room, "subjectId": r["subject_id"], "bindingId": r["binding_id"], "mode": r["mode"], "primaryResponder": r["primary_responder"], "expiresAt": sec(r["expires_at"]), "createdAt": iso(r["created_at"]), "revokedAt": iso(r["revoked_at"]), "state": state, "hostRuntimeState": "unverified"})
		}
		var next any
		if int64(len(rr)) > num(x, "limit") {
			next = items[len(items)-1]["grantId"]
		}
		out := Object{"items": items, "next": next}
		if str(x, "grantId") != "" {
			out["grantId"] = x["grantId"]
			out["state"] = "absent"
			if len(items) > 0 {
				out["state"] = "recorded"
			}
		}
		return out, nil
	})
}
func (s *Service) QueryAgentParticipants(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	x, e := parse(raw, "after", "limit")
	if e != nil {
		return nil, e
	}
	if _, ok := x["after"]; !ok {
		x["after"] = ""
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(50)
	}
	if _, ok := x["after"].(string); !ok || str(x, "after") != "" && !validID(str(x, "after")) || !normalizeInteger(x, "limit", 1, 100) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, true, false)
		if e != nil {
			return nil, e
		}
		rr, e := rows(ctx, tx, `SELECT to_jsonb(g) FROM chat_agent_grants g JOIN chat_memberships m ON m.room_id=g.room_id AND m.subject_id=g.subject_id WHERE g.room_id=$1 AND m.left_at IS NULL AND ($2='' OR g.grant_id::text>$2) AND NOT EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=g.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased')) ORDER BY g.grant_id LIMIT $3`, room, str(x, "after"), num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for i, r := range rr {
			if int64(i) >= num(x, "limit") {
				break
			}
			state, e := s.grantState(ctx, tx, c, r)
			if e != nil {
				return nil, e
			}
			actions := []string{}
			if state == "active" {
				actions = []string{"read"}
				if has([]string{"draft", "respond"}, str(r, "mode")) {
					actions = append(actions, "draft")
				}
				if str(r, "mode") == "respond" {
					actions = append(actions, "respond")
				}
			}
			items = append(items, Object{"grantId": r["grant_id"], "subjectId": r["subject_id"], "mode": r["mode"], "primaryResponder": r["primary_responder"], "expiresAt": sec(r["expires_at"]), "state": state, "hostRuntimeState": "unverified", "readScope": "current-room-authorized-history", "allowedActions": actions})
		}
		var next any
		if int64(len(rr)) > num(x, "limit") {
			next = items[len(items)-1]["grantId"]
		}
		return Object{"items": items, "next": next}, nil
	})
}
func (s *Service) RevokeAgent(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	x, e := loose(raw)
	if e != nil {
		return nil, e
	}
	if !validID(str(x, "grantId")) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		if _, e := s.requireRoom(ctx, tx, a, room, true, true); e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		tag, e := tx.Exec(ctx, "UPDATE chat_agent_grants SET revoked_at=COALESCE(revoked_at,$4) WHERE grant_id=$1 AND room_id=$2 AND subject_id=$3", x["grantId"], room, ref, s.now())
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			return nil, fail("chat_access_denied", 403)
		}
		return Object{"revoked": true, "hostRuntimeStopped": false}, nil
	})
}
