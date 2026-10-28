package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

func parseDecision(raw []byte) (Object, error) {
	x, e := parse(raw, "decisionId", "expectedRevision", "action", "targetSubjectId", "retentionDays", "persistent", "joinRule")
	if e != nil {
		return nil, e
	}
	if !validID(str(x, "decisionId")) || !normalizeInteger(x, "expectedRevision", 1, 9007199254740991) || !has([]string{"invite", "remove", "retention", "become-owner", "transfer-owner", "persistent", "dissolve", "join-rule", "appoint-admin", "revoke-admin", "successor-owner"}, str(x, "action")) {
		return nil, fail("invalid_chat_request", 400)
	}
	if v, present := x["targetSubjectId"]; present && !subjectPattern.MatchString(asString(v)) && !accountPattern.MatchString(asString(v)) {
		return nil, fail("invalid_chat_request", 400)
	}
	if _, present := x["retentionDays"]; present {
		if !normalizeInteger(x, "retentionDays", 7, 90) || num(x, "retentionDays") != 7 && num(x, "retentionDays") != 30 && num(x, "retentionDays") != 90 {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	if v, present := x["persistent"]; present {
		if _, ok := v.(bool); !ok {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	if v, present := x["joinRule"]; present {
		r, ok := v.(map[string]any)
		if !ok || !strict(r, "mode", "expiresAt") || !has([]string{"approval-required", "member-invite", "manager-invite", "open"}, str(r, "mode")) {
			return nil, fail("invalid_chat_request", 400)
		}
		if _, present := r["expiresAt"]; present && !normalizeInteger(r, "expiresAt", 1, 9007199254740991) {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	return x, nil
}
func (s *Service) assertProposal(c roomContext, proposer string, x Object) error {
	r := c.Room
	action := str(x, "action")
	if str(r, "state") == "owner-succession" && action != "successor-owner" && action != "dissolve" {
		return fail("chat_room_read_only")
	}
	if action == "successor-owner" && (str(r, "state") != "owner-succession" || r["succession_expires_at"] == nil || sec(r["succession_expires_at"]) <= s.now().Unix()) {
		return fail("chat_succession_unavailable")
	}
	if action == "transfer-owner" && str(r, "owner_subject_id") != proposer {
		return fail("chat_owner_required")
	}
	if (action == "appoint-admin" || action == "revoke-admin") && str(r, "mode") != "owned" {
		return fail("chat_owner_missing")
	}
	admins := administrators(c)
	if action == "appoint-admin" {
		if str(r, "owner_subject_id") == str(x, "targetSubjectId") || has(admins, str(x, "targetSubjectId")) {
			return fail("chat_already_manager")
		}
		if 1+len(admins) >= 10 {
			return fail("chat_administrator_limit")
		}
	}
	if action == "revoke-admin" && !has(admins, str(x, "targetSubjectId")) {
		return fail("chat_administrator_not_found")
	}
	if action == "join-rule" {
		rule := obj(x, "joinRule")
		if rule["expiresAt"] != nil && num(rule, "expiresAt") <= s.now().Unix() {
			return fail("chat_join_rule_expired")
		}
		if str(rule, "mode") == "manager-invite" && str(r, "mode") != "owned" {
			return fail("chat_owner_missing")
		}
	}
	return nil
}
func (s *Service) decisionView(ctx context.Context, tx pgx.Tx, a Actor, d Object, c roomContext) (Object, error) {
	ref, _ := actorRef(a)
	party := ""
	for _, m := range c.Members {
		if str(m, "subject_id") == ref {
			party = str(m, "controller_ref")
		}
	}
	state := str(d, "state")
	effective := state
	if state == "pending" || state == "approved" {
		if num(d, "member_revision") != num(c.Room, "member_revision") {
			effective = "stale"
		} else if millis(d["expires_at"]) <= s.now().UnixMilli() {
			effective = "expired"
		}
	}
	closed := ""
	if effective == "stale" {
		closed = "chat_membership_changed"
	} else if effective == "expired" {
		closed = "chat_decision_expired"
	}
	pending := closed
	if pending == "" {
		if effective != "pending" {
			pending = "chat_decision_unavailable"
		} else if party == "" {
			pending = "chat_access_denied"
		}
	}
	reasons := Object{"approve": null(pending), "reject": null(pending), "cancel": null(pending), "accept": null(closed), "decline": null(closed)}
	required := uniqueStrings(d["required_parties"])
	if pending == "" {
		if !has(required, party) {
			reasons["approve"] = "chat_vote_not_required"
			reasons["reject"] = "chat_vote_not_required"
		}
		if ref != str(d, "proposer_subject_id") {
			reasons["cancel"] = "chat_cancel_proposer_required"
		}
	}
	proposal := func() error {
		if str(c.Room, "state") == "archived" {
			return fail("chat_room_read_only")
		}
		if e := s.assertProposal(c, str(d, "proposer_subject_id"), obj(d, "payload")); e != nil {
			return e
		}
		if str(d, "action") == "invite" {
			return assertTarget(c.Governance, "invitations-paused")
		}
		return nil
	}
	if reasons["approve"] == nil {
		if e := proposal(); e != nil {
			reasons["approve"] = fault.Code(e)
		}
	}
	if closed == "" {
		reason := ""
		accepting := has([]string{"invite", "become-owner", "transfer-owner", "appoint-admin", "successor-owner"}, str(d, "action"))
		switch {
		case effective != "approved" || !accepting:
			reason = "chat_decision_unavailable"
		case str(obj(d, "payload"), "targetSubjectId") != ref:
			reason = "chat_invitation_target_required"
		case str(c.Room, "state") == "archived":
			reason = "chat_decision_unavailable"
		case str(c.Room, "state") == "owner-succession" && str(d, "action") != "successor-owner":
			reason = "chat_room_read_only"
		case str(d, "action") == "successor-owner" && (str(c.Room, "state") != "owner-succession" || millis(c.Room["succession_expires_at"]) <= s.now().UnixMilli()):
			reason = "chat_succession_unavailable"
		case str(d, "action") != "invite" && party == "":
			reason = "chat_access_denied"
		}
		reasons["accept"] = null(reason)
		reasons["decline"] = null(reason)
	}
	if reasons["accept"] == nil {
		var e error
		if _, e = s.requireAccount(ctx, tx, a); e == nil {
			e = s.assertProposal(c, str(d, "proposer_subject_id"), obj(d, "payload"))
		}
		if e == nil {
			e = s.originalRule(c, d)
		}
		if e == nil && str(d, "action") == "invite" {
			e = assertTarget(c.Governance, "invitations-paused")
			if e == nil && c.Room["parent_room_id"] != nil {
				_, e = s.requireRoom(ctx, tx, a, str(c.Room, "parent_room_id"), true, false)
			}
		}
		if e != nil {
			if fault.Code(e) == "internal_error" {
				return nil, e
			}
			reasons["accept"] = fault.Code(e)
		}
	}
	votes := obj(d, "votes")
	voteList := []Object{}
	keys := make([]string, 0, len(votes))
	for key := range votes {
		keys = append(keys, key)
	}
	// PostgreSQL jsonb object order is length then bytes; original Object.values
	// consumes that exact order, including mixed account and identity parties.
	sort.Slice(keys, func(i, j int) bool {
		if len(keys[i]) != len(keys[j]) {
			return len(keys[i]) < len(keys[j])
		}
		return keys[i] < keys[j]
	})
	for _, key := range keys {
		if vote := obj(votes, key); vote != nil {
			voteList = append(voteList, vote)
		}
	}
	var myVote any
	if party != "" {
		myVote = votes[party]
	}
	out := Object{"decisionId": d["decision_id"], "roomId": d["room_id"], "action": d["action"], "payload": d["payload"], "state": d["state"], "effectiveState": effective, "memberRevision": d["member_revision"], "proposerSubjectId": d["proposer_subject_id"], "votes": voteList, "myVote": myVote, "requiredPartyCount": len(required), "expiresAt": iso(d["expires_at"]), "canApprove": reasons["approve"] == nil, "canReject": reasons["reject"] == nil, "canCancel": reasons["cancel"] == nil, "canAccept": reasons["accept"] == nil, "canDecline": reasons["decline"] == nil, "actionReasons": reasons}
	if d["authority_rule_version"] != nil {
		out["joinRuleAuthorization"] = Object{"version": d["authority_rule_version"], "hash": d["authority_rule_hash"]}
	}
	return out, nil
}
func (s *Service) originalRule(c roomContext, d Object) error {
	if d["authority_rule_version"] == nil {
		return nil
	}
	rule := roomRule(c.Room, s.now().Unix())
	if !truth(rule, "active") || num(rule, "version") != num(d, "authority_rule_version") || ruleHash(rule) != str(d, "authority_rule_hash") {
		return fail("chat_join_rule_changed")
	}
	return nil
}
func (s *Service) Propose(ctx context.Context, a Actor, id string, raw []byte) (Object, error) {
	x, e := parseDecision(raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		if _, e := s.requireAccount(ctx, tx, a); e != nil {
			return nil, e
		}
		if (str(x, "action") == "join-rule") != (x["joinRule"] != nil) {
			return nil, fail("invalid_chat_request", 400)
		}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "chat-decision:"+str(x, "decisionId")); e != nil {
			return nil, e
		}
		c, e := s.requireRoom(ctx, tx, a, id, true, true)
		if e != nil {
			return nil, e
		}
		ref, _ := actorRef(a)
		old, e := row(ctx, tx, "SELECT to_jsonb(d) FROM chat_decisions d WHERE decision_id=$1", x["decisionId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if str(old, "room_id") != id || str(old, "proposer_subject_id") != ref || str(old, "request_hash") != canonical(x) {
				return nil, fail("chat_operation_conflict")
			}
			return s.decisionView(ctx, tx, a, old, c)
		}
		action := str(x, "action")
		if action == "invite" {
			if e = s.ensureParticipant(ctx, tx, str(x, "targetSubjectId")); e != nil {
				return nil, e
			}
			if e = assertTarget(c.Governance, "invitations-paused"); e != nil {
				return nil, e
			}
		}
		if str(c.Room, "state") == "archived" || num(c.Room, "revision") != num(x, "expectedRevision") {
			return nil, fail("chat_revision_conflict")
		}
		targetRequired := has([]string{"invite", "remove", "become-owner", "transfer-owner", "appoint-admin", "revoke-admin", "successor-owner"}, action)
		if targetRequired && x["targetSubjectId"] == nil {
			return nil, fail("chat_target_required", 400)
		}
		targetMember := false
		targetParty := ""
		party := ""
		for _, m := range c.Members {
			if str(m, "subject_id") == str(x, "targetSubjectId") {
				targetMember = true
				targetParty = str(m, "controller_ref")
			}
			if str(m, "subject_id") == ref {
				party = str(m, "controller_ref")
			}
		}
		if action == "invite" && targetMember {
			return nil, fail("chat_already_member")
		}
		if has([]string{"become-owner", "transfer-owner", "appoint-admin", "revoke-admin", "successor-owner"}, action) && !targetMember {
			return nil, fail("chat_target_not_member")
		}
		if action == "become-owner" && str(c.Room, "mode") != "ownerless" {
			return nil, fail("chat_owner_already_exists")
		}
		if action == "transfer-owner" && str(c.Room, "mode") != "owned" {
			return nil, fail("chat_owner_missing")
		}
		if e = s.assertProposal(c, ref, x); e != nil {
			return nil, e
		}
		required := append([]string{}, c.Parties...)
		var ruleVersion, ruleDigest any
		if action == "invite" {
			rule := roomRule(c.Room, s.now().Unix())
			if str(rule, "effectiveMode") != "approval-required" {
				if str(rule, "effectiveMode") == "manager-invite" && !(str(c.Room, "mode") == "owned" && (str(c.Room, "owner_subject_id") == ref || has(administrators(c), ref))) {
					return nil, fail("chat_manager_required", 403)
				}
				ruleVersion = rule["version"]
				ruleDigest = ruleHash(rule)
				required = []string{party}
			}
			if e = s.consumeInvite(ctx, tx, a, id, x); e != nil {
				return nil, e
			}
		}
		if action == "remove" {
			if !targetMember {
				return nil, fail("chat_target_not_member")
			}
			required = []string{}
			for _, p := range c.Parties {
				if p != targetParty {
					required = append(required, p)
				}
			}
			if len(required) < 2 {
				return nil, fail("chat_two_party_removal_forbidden")
			}
			if targetParty == party {
				return nil, fail("chat_use_leave")
			}
		}
		if action == "retention" && x["retentionDays"] == nil || action == "persistent" && x["persistent"] == nil {
			return nil, fail("invalid_chat_request", 400)
		}
		votes := Object{party: Object{"subjectId": ref, "choice": "approve"}}
		approved := true
		for _, p := range required {
			approved = approved && votes[p] != nil
		}
		state := "pending"
		if approved {
			state = "approved"
		}
		d, e := row(ctx, tx, `INSERT INTO chat_decisions(decision_id,room_id,proposer_subject_id,member_revision,required_parties,votes,action,payload,request_hash,state,created_at,expires_at,authority_rule_version,authority_rule_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING to_jsonb(chat_decisions)`, x["decisionId"], id, ref, num(c.Room, "member_revision"), encode(required), encode(votes), action, encode(x), canonical(x), state, s.now(), s.now().Add(7*24*time.Hour), ruleVersion, ruleDigest)
		if e != nil {
			return nil, e
		}
		if approved {
			d, e = s.applyDecision(ctx, tx, c, d)
			if e != nil {
				return nil, e
			}
		}
		return s.decisionView(ctx, tx, a, d, c)
	})
}
