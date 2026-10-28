package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) applyDecision(ctx context.Context, tx pgx.Tx, c roomContext, d Object) (Object, error) {
	x, r := obj(d, "payload"), c.Room
	action := str(d, "action")
	if has([]string{"invite", "become-owner", "transfer-owner", "appoint-admin", "successor-owner"}, action) {
		return d, nil
	}
	id := str(r, "room_id")
	var e error
	switch action {
	case "remove":
		_, e = tx.Exec(ctx, "UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2", id, x["targetSubjectId"], s.now())
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE chat_agent_grants SET revoked_at=$3 WHERE room_id=$1 AND subject_id=$2 AND revoked_at IS NULL", id, x["targetSubjectId"], s.now())
		}
		if e == nil && str(r, "owner_subject_id") == str(x, "targetSubjectId") {
			_, e = tx.Exec(ctx, "UPDATE chat_rooms SET state='owner-succession',succession_expires_at=$2 WHERE room_id=$1", id, s.now().Add(7*24*time.Hour))
		}
	case "retention":
		_, e = tx.Exec(ctx, "UPDATE chat_rooms SET retention_days=$2 WHERE room_id=$1", id, x["retentionDays"])
	case "persistent":
		_, e = tx.Exec(ctx, "UPDATE chat_rooms SET persistent=$2 WHERE room_id=$1", id, x["persistent"])
	case "join-rule":
		rule := roomRule(r, s.now().Unix())
		selected := obj(x, "joinRule")
		_, e = tx.Exec(ctx, "UPDATE chat_rooms SET join_rule=$2 WHERE room_id=$1", id, encode(Object{"mode": selected["mode"], "version": num(rule, "version") + 1, "decisionId": d["decision_id"], "requestHash": d["request_hash"], "expiresAt": selected["expiresAt"]}))
	case "dissolve":
		_, e = tx.Exec(ctx, "UPDATE chat_rooms SET state='archived' WHERE room_id=$1", id)
	}
	if e != nil {
		return nil, e
	}
	if action == "remove" || action == "revoke-admin" {
		admins := []string{}
		for _, admin := range administrators(c) {
			if admin != str(x, "targetSubjectId") {
				admins = append(admins, admin)
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_rooms SET administrator_ids=$2 WHERE room_id=$1", id, encode(admins)); e != nil {
			return nil, e
		}
	}
	delta := 0
	if action == "remove" || action == "revoke-admin" || action == "join-rule" {
		delta = 1
	}
	if _, e = tx.Exec(ctx, "UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+$2,updated_at=$3 WHERE room_id=$1", id, delta, s.now()); e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, "UPDATE chat_decisions SET state='accepted' WHERE decision_id=$1", d["decision_id"]); e != nil {
		return nil, e
	}
	d["state"] = "accepted"
	return d, nil
}
func (s *Service) Accept(ctx context.Context, a Actor, id string, raw []byte) (Object, error) {
	x, e := loose(raw)
	if e != nil || !validID(str(x, "decisionId")) {
		return nil, fail("invalid_chat_request", 400)
	}
	accept := true
	if v, present := x["accept"]; present {
		var ok bool
		accept, ok = v.(bool)
		if !ok {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		if accept {
			if _, e = s.requireAccount(ctx, tx, a); e != nil {
				return nil, e
			}
		}
		c, e := s.requireRoom(ctx, tx, a, id, false, true)
		if e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		d, e := row(ctx, tx, "SELECT to_jsonb(d) FROM chat_decisions d WHERE decision_id=$1 AND room_id=$2 FOR UPDATE", x["decisionId"], id)
		if e != nil {
			return nil, e
		}
		if d == nil || !has([]string{"invite", "become-owner", "transfer-owner", "appoint-admin", "successor-owner"}, str(d, "action")) || str(obj(d, "payload"), "targetSubjectId") != ref {
			return nil, fail("chat_access_denied", 403)
		}
		active := false
		for _, m := range c.Members {
			active = active || str(m, "subject_id") == ref
		}
		if str(d, "state") == "accepted" {
			out := Object{"state": "accepted", "membershipActive": active}
			if active {
				out["room"] = s.view(c)
			}
			return out, nil
		}
		if str(d, "state") != "approved" || str(c.Room, "state") == "archived" {
			return nil, fail("chat_decision_unavailable")
		}
		if num(d, "member_revision") != num(c.Room, "member_revision") {
			return nil, fail("chat_membership_changed")
		}
		if millis(d["expires_at"]) <= s.now().UnixMilli() {
			return nil, fail("chat_invitation_expired")
		}
		if str(c.Room, "state") == "owner-succession" && str(d, "action") != "successor-owner" {
			return nil, fail("chat_room_read_only")
		}
		if str(d, "action") == "successor-owner" && (str(c.Room, "state") != "owner-succession" || millis(c.Room["succession_expires_at"]) <= s.now().UnixMilli()) {
			return nil, fail("chat_succession_unavailable")
		}
		if accept {
			if e = s.assertProposal(c, str(d, "proposer_subject_id"), obj(d, "payload")); e != nil {
				return nil, e
			}
			if e = s.originalRule(c, d); e != nil {
				return nil, e
			}
		}
		if str(d, "action") == "invite" {
			if e = s.publicWrites().MarkInvitationRespondedWithin(ctx, tx, publicwrites.Targets{RoomID: id, RecipientID: ref}); e != nil {
				return nil, e
			}
		}
		if !accept {
			_, e = tx.Exec(ctx, "UPDATE chat_decisions SET state='rejected' WHERE decision_id=$1", d["decision_id"])
			if e != nil {
				return nil, e
			}
			return Object{"state": "rejected"}, nil
		}
		if str(d, "action") == "invite" {
			if e = assertTarget(c.Governance, "invitations-paused"); e != nil {
				return nil, e
			}
			if c.Room["parent_room_id"] != nil {
				if _, e = s.requireRoom(ctx, tx, a, str(c.Room, "parent_room_id"), true, false); e != nil {
					return nil, e
				}
			}
			party := ref
			if a.Device != nil {
				if s.Links == nil {
					return nil, fail("chat_control_relationship_unavailable", 503)
				}
				party, e = s.Links.ResolveControlPartyWithin(ctx, tx, ref)
				if e != nil {
					return nil, e
				}
			}
			_, e = tx.Exec(ctx, `INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,subject_id) DO UPDATE SET controller_ref=$3,joined_at=$4,left_at=NULL,dismissed_revision=NULL`, id, ref, party, s.now())
			if e != nil {
				return nil, e
			}
			parties := append([]string{}, c.Parties...)
			if !has(parties, party) {
				parties = append(parties, party)
			}
			_, e = tx.Exec(ctx, "UPDATE chat_rooms SET revision=revision+1,member_revision=member_revision+1,had_multiple=had_multiple OR $2,state=CASE WHEN $2 THEN 'active' ELSE state END,updated_at=$3 WHERE room_id=$1", id, len(parties) > 1, s.now())
		} else if str(d, "action") == "appoint-admin" {
			admins := append(administrators(c), ref)
			_, e = tx.Exec(ctx, "UPDATE chat_rooms SET administrator_ids=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3 WHERE room_id=$1", id, encode(admins), s.now())
		} else {
			if !active {
				return nil, fail("chat_access_denied", 403)
			}
			admins := []string{}
			for _, admin := range administrators(c) {
				if admin != ref {
					admins = append(admins, admin)
				}
			}
			_, e = tx.Exec(ctx, "UPDATE chat_rooms SET mode='owned',owner_subject_id=$2,administrator_ids=$4,persistent=coalesce($5,persistent),state='active',succession_expires_at=NULL,revision=revision+1,member_revision=member_revision+1,updated_at=$3 WHERE room_id=$1", id, ref, s.now(), encode(admins), obj(d, "payload")["persistent"])
		}
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_decisions SET state='accepted' WHERE decision_id=$1", d["decision_id"]); e != nil {
			return nil, e
		}
		current, e := s.requireRoom(ctx, tx, a, id, true, false)
		if e != nil {
			return nil, e
		}
		return Object{"state": "accepted", "room": s.view(current)}, nil
	})
}
func (s *Service) Vote(ctx context.Context, a Actor, id string, raw []byte) (Object, error) {
	x, e := loose(raw)
	if e != nil || !validID(str(x, "decisionId")) || !has([]string{"approve", "reject", "cancel"}, str(x, "choice")) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, id, true, true)
		if e != nil {
			return nil, e
		}
		if str(x, "choice") != "cancel" {
			if _, e = s.requireAccount(ctx, tx, a); e != nil {
				return nil, e
			}
		}
		d, e := row(ctx, tx, "SELECT to_jsonb(d) FROM chat_decisions d WHERE decision_id=$1 AND room_id=$2 FOR UPDATE", x["decisionId"], id)
		if e != nil {
			return nil, e
		}
		if d == nil {
			return nil, fail("chat_decision_not_found", 404)
		}
		if str(d, "state") != "pending" {
			return s.decisionView(ctx, tx, a, d, c)
		}
		ref, _ := actorRef(a)
		if num(d, "member_revision") != num(c.Room, "member_revision") {
			d["state"] = "stale"
		} else if millis(d["expires_at"]) <= s.now().UnixMilli() {
			d["state"] = "expired"
		} else if str(x, "choice") == "cancel" {
			if str(d, "proposer_subject_id") != ref {
				return nil, fail("chat_access_denied", 403)
			}
			d["state"] = "cancelled"
		} else {
			party := ""
			for _, m := range c.Members {
				if str(m, "subject_id") == ref {
					party = str(m, "controller_ref")
				}
			}
			required := uniqueStrings(d["required_parties"])
			if !has(required, party) {
				return nil, fail("chat_access_denied", 403)
			}
			votes := obj(d, "votes")
			votes[party] = Object{"subjectId": ref, "choice": x["choice"]}
			state := "approved"
			if str(x, "choice") == "reject" {
				state = "rejected"
			} else {
				for _, p := range required {
					if str(obj(votes, p), "choice") != "approve" {
						state = "pending"
						break
					}
				}
			}
			d["state"] = state
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_decisions SET votes=$2,state=$3 WHERE decision_id=$1", d["decision_id"], encode(d["votes"]), d["state"]); e != nil {
			return nil, e
		}
		if str(d, "state") == "approved" {
			if e = s.assertProposal(c, str(d, "proposer_subject_id"), obj(d, "payload")); e != nil {
				return nil, e
			}
			if str(d, "action") == "invite" {
				if e = assertTarget(c.Governance, "invitations-paused"); e != nil {
					return nil, e
				}
			}
			d, e = s.applyDecision(ctx, tx, c, d)
			if e != nil {
				return nil, e
			}
		}
		return s.decisionView(ctx, tx, a, d, c)
	})
}
