package chat

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) JoinPreview(ctx context.Context, a Actor, room string) (Object, error) {
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, room, false, false)
		if e != nil {
			return nil, e
		}
		rule := roomRule(c.Room, s.now().Unix())
		if str(rule, "effectiveMode") != "open" || has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
			return nil, fail("chat_access_denied", 403)
		}
		if c.Room["parent_room_id"] != nil {
			if _, e = s.requireRoom(ctx, tx, a, str(c.Room, "parent_room_id"), true, false); e != nil {
				return nil, e
			}
		}
		if e = assertTarget(c.Governance, "invitations-paused"); e != nil {
			return nil, e
		}
		return Object{"roomId": room, "title": c.Room["title"], "ruleVersion": rule["version"], "ruleHash": ruleHash(rule), "joinRule": rule, "retentionDays": c.Room["retention_days"], "historyPolicy": "all-authorized-history", "requiresVerifiedAccount": true, "joiningGrantsOtherMaterials": false, "joiningStartsAgent": false}, nil
	})
}
func (s *Service) Join(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	x, e := parse(raw, "operationId", "ruleVersion", "ruleHash")
	if e != nil {
		return nil, e
	}
	if !validID(str(x, "operationId")) || !normalizeInteger(x, "ruleVersion", 1, 9007199254740991) || !hashPattern.MatchString(str(x, "ruleHash")) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "chat-decision:"+str(x, "operationId")); e != nil {
			return nil, e
		}
		c, e := s.requireRoom(ctx, tx, a, room, false, true)
		if e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		previous, e := row(ctx, tx, "SELECT to_jsonb(d) FROM chat_decisions d WHERE decision_id=$1", x["operationId"])
		if e != nil {
			return nil, e
		}
		if previous != nil {
			if str(previous, "action") != "open-join" || str(previous, "room_id") != room || str(previous, "proposer_subject_id") != ref || str(previous, "request_hash") != canonical(x) {
				return nil, fail("chat_operation_conflict")
			}
			active := false
			for _, m := range c.Members {
				active = active || str(m, "subject_id") == ref
			}
			result := Object{"state": "accepted", "membershipActive": active}
			if active {
				result["room"] = s.view(c)
			}
			return result, nil
		}
		rule := roomRule(c.Room, s.now().Unix())
		if str(rule, "effectiveMode") != "open" || has([]string{"archived", "owner-succession"}, str(c.Room, "state")) {
			return nil, fail("chat_access_denied", 403)
		}
		if num(rule, "version") != num(x, "ruleVersion") || ruleHash(rule) != str(x, "ruleHash") {
			return nil, fail("chat_join_rule_changed")
		}
		if e = assertTarget(c.Governance, "invitations-paused"); e != nil {
			return nil, e
		}
		if _, e = s.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		if c.Room["parent_room_id"] != nil {
			if _, e = s.requireRoom(ctx, tx, a, str(c.Room, "parent_room_id"), true, false); e != nil {
				return nil, e
			}
		}
		for _, m := range c.Members {
			if str(m, "subject_id") == ref {
				return nil, fail("chat_already_member")
			}
		}
		party := ref
		if a.Device != nil {
			party, e = s.Links.ResolveControlPartyWithin(ctx, tx, ref)
			if e != nil {
				return nil, e
			}
		}
		if party == "" {
			return nil, fail("chat_control_relationship_unavailable", 503)
		}
		if _, e = tx.Exec(ctx, `INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,subject_id) DO UPDATE SET controller_ref=$3,joined_at=$4,left_at=NULL,dismissed_revision=NULL`, room, ref, party, s.now()); e != nil {
			return nil, e
		}
		multiple := len(c.Parties) > 1 || len(c.Parties) == 1 && c.Parties[0] != party
		if _, e = tx.Exec(ctx, "UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+1,had_multiple=had_multiple OR $2,state=CASE WHEN $2 THEN 'active' ELSE state END,updated_at=$3 WHERE room_id=$1", room, multiple, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO chat_decisions(decision_id,room_id,proposer_subject_id,member_revision,required_parties,votes,action,payload,request_hash,state,created_at,expires_at,authority_rule_version,authority_rule_hash) VALUES($1,$2,$3,$4,'[]','{}','open-join',$5,$6,'accepted',$7,$8,$9,$10)`, x["operationId"], room, ref, num(c.Room, "member_revision"), encode(x), canonical(x), s.now(), s.now().Add(7*24*time.Hour), num(rule, "version"), ruleHash(rule)); e != nil {
			return nil, e
		}
		current, e := s.requireRoom(ctx, tx, a, room, true, false)
		if e != nil {
			return nil, e
		}
		return Object{"state": "accepted", "membershipActive": true, "room": s.view(current)}, nil
	})
}
