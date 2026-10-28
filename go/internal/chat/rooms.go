package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

type roomContext struct {
	Room       Object
	Members    []Object
	Parties    []string
	Governance Object
}

func (s *Service) members(ctx context.Context, tx pgx.Tx, room string) ([]Object, error) {
	return rows(ctx, tx, `SELECT to_jsonb(m)||jsonb_build_object('display_name',p.display_name,'uid',account.uid) FROM chat_memberships m LEFT JOIN chat_participants_v3 a ON a.actor_ref=m.subject_id LEFT JOIN community_accounts account ON account.id=a.account_id LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.account_id WHERE m.room_id=$1 AND m.left_at IS NULL ORDER BY m.subject_id`, room)
}
func (s *Service) restrictions(ctx context.Context, tx pgx.Tx, room, parent string) (Object, error) {
	ids := []string{room}
	if parent != "" {
		ids = append(ids, parent)
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM (SELECT id,restriction_scopes,restriction_until,restriction_event_id FROM target_reports_v2 WHERE room_id=ANY($1::uuid[]) AND restriction_until>$2 ORDER BY id)r", ids, s.now())
	if e != nil {
		return nil, e
	}
	account, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM (SELECT id,restriction_scopes,restriction_until,restriction_event_id FROM account_chat_reports_v1 WHERE room_id=ANY($1::uuid[]) AND restriction_until>$2 ORDER BY id)r", ids, s.now())
	if e != nil {
		return nil, e
	}
	rr = append(rr, account...)
	scopes := []string{}
	restrictions := []Object{}
	for _, r := range rr {
		for _, scope := range uniqueStrings(r["restriction_scopes"]) {
			if !has(scopes, scope) {
				scopes = append(scopes, scope)
			}
		}
		restrictions = append(restrictions, Object{"reportId": r["id"], "eventId": r["restriction_event_id"], "scopes": r["restriction_scopes"], "until": iso(r["restriction_until"])})
	}
	return Object{"scopes": scopes, "restrictions": restrictions, "authority": "current-target-operation-restrictions; not-capability-or-source-permission"}, nil
}
func assertTarget(restrictions Object, scope string) error {
	values, ok := restrictions["scopes"].([]string)
	if !ok {
		values = uniqueStrings(restrictions["scopes"])
	}
	if has(values, scope) {
		return fail("target_operation_restricted")
	}
	return nil
}
func (s *Service) requireRoom(ctx context.Context, tx pgx.Tx, a Actor, id string, member, write bool) (roomContext, error) {
	ref, e := actorRef(a)
	if e != nil {
		return roomContext{}, e
	}
	return s.requireRoomRef(ctx, tx, ref, id, member, write)
}

// requireRoomRef also serves the accepted-contact adapter after both exact
// private grants establish its two parties. It creates no credential identity.
func (s *Service) requireRoomRef(ctx context.Context, tx pgx.Tx, ref string, id string, member, write bool) (roomContext, error) {
	var out roomContext
	if !validID(id) {
		return out, fail("invalid_chat_request", 400)
	}
	lock := " FOR SHARE"
	if write {
		lock = " FOR UPDATE"
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(r) FROM chat_rooms r WHERE room_id=$1"+lock, id)
	if e != nil {
		return out, e
	}
	if r == nil {
		return out, fail("chat_room_not_found", 404)
	}
	members, e := s.members(ctx, tx, id)
	if e != nil {
		return out, e
	}
	found := false
	ids := []string{ref}
	for _, m := range members {
		found = found || str(m, "subject_id") == ref
		ids = append(ids, str(m, "subject_id"))
	}
	if member && !found {
		return out, fail("chat_access_denied", 403)
	}
	if member && r["parent_room_id"] != nil {
		if _, e = s.requireRoomRef(ctx, tx, ref, str(r, "parent_room_id"), true, false); e != nil {
			return out, e
		}
	}
	if e = accountlinks.LockMappingsWithin(ctx, tx, s.Endpoint, ids, false); e != nil {
		return out, e
	}
	mapped := []Object{}
	parties := []string{}
	changed := false
	for _, m := range members {
		party := str(m, "subject_id")
		if !accountPattern.MatchString(party) {
			if s.Links == nil {
				return out, fail("chat_control_relationship_unavailable", 503)
			}
			party, e = s.Links.ResolveControlPartyWithin(ctx, tx, party)
			if e != nil {
				return out, e
			}
		}
		if party == "" {
			return out, fail("chat_control_relationship_unavailable", 503)
		}
		changed = changed || party != str(m, "controller_ref")
		m["controller_ref"] = party
		mapped = append(mapped, m)
		if !has(parties, party) {
			parties = append(parties, party)
		}
	}
	sort.Strings(parties)
	if changed {
		if write {
			for _, m := range mapped {
				if _, e = tx.Exec(ctx, "UPDATE chat_memberships SET controller_ref=$3 WHERE room_id=$1 AND subject_id=$2", id, m["subject_id"], m["controller_ref"]); e != nil {
					return out, e
				}
			}
			if _, e = tx.Exec(ctx, "UPDATE chat_rooms SET member_revision=member_revision+1,revision=revision+1 WHERE room_id=$1", id); e != nil {
				return out, e
			}
		}
		r["member_revision"] = num(r, "member_revision") + 1
		r["revision"] = num(r, "revision") + 1
	}
	governance, e := s.restrictions(ctx, tx, id, str(r, "parent_room_id"))
	if e != nil {
		return out, e
	}
	return roomContext{r, mapped, parties, governance}, nil
}
func administrators(c roomContext) []string {
	out := []string{}
	for _, id := range uniqueStrings(c.Room["administrator_ids"]) {
		for _, m := range c.Members {
			if id == str(m, "subject_id") && id != str(c.Room, "owner_subject_id") {
				out = append(out, id)
				break
			}
		}
	}
	return out
}
func (s *Service) view(c roomContext) Object {
	r := c.Room
	members := []Object{}
	for _, m := range c.Members {
		members = append(members, Object{"subjectId": m["subject_id"], "actor": actorView(str(m, "subject_id")), "uid": m["uid"], "displayName": m["display_name"], "joinedAt": iso(m["joined_at"]), "singleMemberPromptDismissed": m["dismissed_revision"] != nil && num(m, "dismissed_revision") == num(r, "revision")})
	}
	rule := roomRule(r, s.now().Unix())
	rule["ruleHash"] = ruleHash(rule)
	return Object{"roomId": r["room_id"], "title": r["title"], "kind": r["kind"], "parentRoomId": r["parent_room_id"], "taskRefs": r["task_refs"], "revision": r["revision"], "memberRevision": r["member_revision"], "state": r["state"], "mode": r["mode"], "ownerSubjectId": r["owner_subject_id"], "persistent": r["persistent"], "retentionDays": r["retention_days"], "historyPolicy": "all-authorized-history", "independentMemberCount": len(c.Parties), "joinRule": rule, "administratorSubjectIds": administrators(c), "successionExpiresAt": iso(r["succession_expires_at"]), "managementAuthority": Object{"basis": "current-room-role-and-explicit-shared-rule", "managerLimit": 10, "privateMaterialsGranted": false, "otherAgentControlGranted": false}, "membershipBasis": "explicit-subject-and-verified-control-relationships", "connectionCount": nil, "decisionRequired": str(r, "state") == "single-member-decision", "members": members, "transportAvailable": s.Transport != nil && s.Transport.Available(), "governance": c.Governance}
}
func (s *Service) project(ctx context.Context, c roomContext) error {
	members := []string{}
	for _, m := range c.Members {
		members = append(members, str(m, "subject_id"))
	}
	_, e := s.command(ctx, "project", Object{"roomId": c.Room["room_id"], "revision": c.Room["revision"], "title": c.Room["title"], "state": c.Room["state"], "members": members})
	return e
}
func (s *Service) Get(ctx context.Context, a Actor, id string) (Object, error) {
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, id, true, false)
		if e != nil {
			return nil, e
		}
		return s.view(c), nil
	})
}
func (s *Service) Create(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := parseCreate(raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		ref, _ := actorRef(a)
		if e := accountlinks.LockMappingsWithin(ctx, tx, s.Endpoint, []string{ref}, false); e != nil {
			return nil, e
		}
		if _, e = s.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		old, e := row(ctx, tx, "SELECT to_jsonb(r) FROM chat_rooms r WHERE creator_subject_id=$1 AND operation_id=$2", ref, x["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if str(old, "request_hash") != canonical(x) {
				return nil, fail("chat_operation_conflict")
			}
			c, e := s.requireRoom(ctx, tx, a, str(old, "room_id"), true, false)
			if e != nil {
				return nil, e
			}
			return s.view(c), nil
		}
		if x["parentRoomId"] != nil {
			if str(x, "kind") != "ai-subzone" {
				return nil, fail("invalid_chat_request", 400)
			}
			if _, e = s.requireRoom(ctx, tx, a, str(x, "parentRoomId"), true, false); e != nil {
				return nil, e
			}
		} else if str(x, "kind") == "ai-subzone" {
			return nil, fail("chat_parent_required", 400)
		}
		tasks := uniqueStrings(x["taskRefs"])
		for _, task := range tasks {
			if s.TaskReference == nil {
				return nil, fail("chat_task_link_unavailable", 503)
			}
			if e = s.TaskReference(ctx, tx, a, task); e != nil {
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
		tag, e := tx.Exec(ctx, `INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,kind,parent_room_id,task_refs,retention_days,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT DO NOTHING`, x["roomId"], ref, x["operationId"], canonical(x), x["title"], x["kind"], x["parentRoomId"], encode(x["taskRefs"]), num(x, "retentionDays"), s.now())
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			old, e := row(ctx, tx, "SELECT to_jsonb(r) FROM chat_rooms r WHERE creator_subject_id=$1 AND operation_id=$2", ref, x["operationId"])
			if e != nil {
				return nil, e
			}
			if old == nil || str(old, "request_hash") != canonical(x) {
				return nil, fail("chat_operation_conflict")
			}
			c, e := s.requireRoom(ctx, tx, a, str(old, "room_id"), true, false)
			if e != nil {
				return nil, e
			}
			return s.view(c), nil
		}
		if _, e = tx.Exec(ctx, "INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)", x["roomId"], ref, party, s.now()); e != nil {
			return nil, e
		}
		c, e := s.requireRoom(ctx, tx, a, str(x, "roomId"), true, false)
		if e != nil {
			return nil, e
		}
		return s.view(c), nil
	})
}
func (s *Service) List(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := parsePage(raw, "after", "limit")
	if e != nil {
		return nil, e
	}
	after := str(x, "after")
	if after != "" && !validID(after) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		ref, _ := actorRef(a)
		rr, e := rows(ctx, tx, "SELECT jsonb_build_object('room_id',r.room_id) FROM chat_rooms r JOIN chat_memberships m USING(room_id) WHERE m.subject_id=$1 AND m.left_at IS NULL AND ($2='' OR r.room_id::text>$2) ORDER BY r.room_id LIMIT $3", ref, after, num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		rooms := []Object{}
		for i, r := range rr {
			if int64(i) >= num(x, "limit") {
				break
			}
			c, e := s.requireRoom(ctx, tx, a, str(r, "room_id"), true, false)
			if e != nil {
				return nil, e
			}
			rooms = append(rooms, s.view(c))
		}
		var next any
		if int64(len(rr)) > num(x, "limit") {
			next = rooms[len(rooms)-1]["roomId"]
		}
		return Object{"rooms": rooms, "next": next}, nil
	})
}
func (s *Service) Leave(ctx context.Context, a Actor, id string) (Object, error) {
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		c, e := s.requireRoom(ctx, tx, a, id, false, true)
		if e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		present := false
		parties := []string{}
		for _, m := range c.Members {
			if str(m, "subject_id") == ref {
				present = true
			} else if !has(parties, str(m, "controller_ref")) {
				parties = append(parties, str(m, "controller_ref"))
			}
		}
		if !present {
			return Object{"left": true, "taskParticipationChanged": false}, nil
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2", id, ref, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_agent_grants SET revoked_at=$3 WHERE room_id=$1 AND subject_id=$2 AND revoked_at IS NULL", id, ref, s.now()); e != nil {
			return nil, e
		}
		state := str(c.Room, "state")
		if len(parties) == 0 {
			state = "archived"
		} else if str(c.Room, "owner_subject_id") == ref {
			state = "owner-succession"
		} else if len(parties) == 1 && str(c.Room, "mode") == "ownerless" && truth(c.Room, "had_multiple") {
			state = "single-member-decision"
		}
		admins := []string{}
		for _, admin := range administrators(c) {
			if admin != ref {
				admins = append(admins, admin)
			}
		}
		_, e = tx.Exec(ctx, `UPDATE chat_rooms SET state=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3,administrator_ids=$5,succession_expires_at=CASE WHEN $2='owner-succession' AND state<>'owner-succession' THEN $4 ELSE succession_expires_at END WHERE room_id=$1`, id, state, s.now(), s.now().Add(7*24*time.Hour), encode(admins))
		if e != nil {
			return nil, e
		}
		return Object{"left": true, "taskParticipationChanged": false}, nil
	})
}
