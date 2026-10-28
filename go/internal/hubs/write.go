package hubs

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"sort"
)

func (s *Service) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, row Object, requestID string) error {
	var rid any
	if requestID != "" {
		rid = requestID
	}
	scopes, _ := protocol.Encode(auth.CredentialScopes)
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,'hub.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'builders',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5 AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$6 AND c.subject_id=$1`, a.SubjectID, row["id"], rid, string(scopes), a.BindingID, row["consent_id"])
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fault.New("hub_audit_unavailable", 500)
	}
	return nil
}
func receipt(row Object) Object {
	return flag(Object{"operationId": row["id"], "hubId": row["hub_id"], "kind": row["kind"], "version": row["object_version"], "objectId": row["object_id"], "charterVersion": row["charter_version"], "payloadHash": row["payload_hash"], "state": "recorded"})
}
func sameViewers(a, b []string) bool {
	x := append([]string{}, a...)
	y := append([]string{}, b...)
	sort.Strings(x)
	sort.Strings(y)
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}
func (s *Service) Submit(ctx context.Context, a deviceauth.Actor, input Object, requestID string) (Object, error) {
	encoded, err := protocol.Encode(input)
	if err != nil {
		return nil, fault.New("invalid_hub_write", 400)
	}
	if _, err = parse("peeringWriteSchema", encoded); err != nil {
		return nil, fault.New("invalid_hub_write", 400)
	}
	payload, ok := input["payloadJson"].(string)
	if !ok || len([]byte(payload)) > 48000 || len(input) != 2 {
		return nil, fault.New("invalid_hub_event", 400)
	}
	consent, ok := input["consentId"].(string)
	if !ok {
		return nil, fault.New("invalid_hub_event", 400)
	}
	ev, e := parse("hubEventSchema", []byte(payload))
	if e != nil {
		return nil, fault.New("invalid_hub_event", 400)
	}
	kind := txt(ev, "kind")
	control := has([]any{"exit", "decline", "remove", "suspend", "intake-close"}, kind)
	return s.run(ctx, &a, true, control, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		row := Object{"id": ev["id"], "subject_id": a.SubjectID, "consent_id": consent, "payload_text": payload, "payload_hash": identity.Digest([]byte(payload))}
		grant, e := s.grant(ctx, tx, row)
		if e != nil {
			return nil, e
		}
		prior, e := one(ctx, tx, "SELECT * FROM hub_events_v2 WHERE id=$1", ev["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["subject_id"] != a.SubjectID || prior["consent_id"] != consent || prior["payload_hash"] != row["payload_hash"] {
				return nil, fault.New("hub_event_conflict", 409)
			}
			return receipt(prior), nil
		}
		if kind == "charter" && num(ev, "expectedVersion") == 0 {
			b, e := s.registry(ctx, tx, &a, txt(ev, "hubId"))
			if e != nil {
				return nil, e
			}
			if b.Parent["type"] != "hub" || b.Parent["owner_id"] != a.SubjectID {
				return nil, fault.New("hub_operator_required", 403)
			}
			if _, e = tx.Exec(ctx, "INSERT INTO hub_heads_v2(id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING", ev["hubId"], a.SubjectID); e != nil {
				return nil, e
			}
		}
		head, e := s.head(ctx, tx, txt(ev, "hubId"), true)
		if e != nil {
			return nil, e
		}
		owner := a.SubjectID == head["owner_id"]
		var objectID, cv any
		var objectVersion int64
		pair := func(other string) error {
			return require(grant.Visibility == "Private" && len(grant.Viewers) == 1 && grant.Viewers[0] == other, "hub_private_recipient_required", 403)
		}
		switch kind {
		case "charter":
			if !owner {
				return nil, fault.New("hub_operator_required", 403)
			}
			if num(head, "version") != num(ev, "expectedVersion") || num(head, "version") >= 1000 {
				return nil, fault.New("hub_version_conflict", 409)
			}
			b, e := s.registry(ctx, tx, &a, txt(ev, "hubId"))
			if e != nil {
				return nil, e
			}
			if b.DeclarationEvent["id"] != ev["declarationId"] || b.DeclarationEvent["payload_hash"] != ev["declarationHash"] {
				return nil, fault.New("hub_declaration_changed", 409)
			}
			if grant.Visibility != b.Grant.Visibility || !sameViewers(grant.Viewers, b.Grant.Viewers) {
				return nil, fault.New("hub_visibility_mismatch", 403)
			}
			for _, raw := range obj(ev["charter"]) {
				clause := obj(raw)
				if clause == nil || clause["status"] == nil {
					continue
				}
				if num(clause, "asOf") > s.now() {
					return nil, fault.New("hub_future_claim", 400)
				}
				if ref := obj(clause["reportRef"]); ref != nil {
					r, e := one(ctx, tx, "SELECT * FROM builder_events WHERE id=$1 AND builder_id=$2 AND kind='scope-report'", ref["eventId"], ev["hubId"])
					if e != nil {
						return nil, e
					}
					permitted := false
					if r != nil {
						permitted, e = s.Builders.EventPermittedWithin(ctx, tx, &a, r)
						if e != nil {
							return nil, e
						}
					}
					if r == nil || r["payload_hash"] != ref["payloadHash"] || !permitted {
						return nil, fault.New("hub_report_unavailable", 409)
					}
					found := false
					for _, check := range arr(event(r)["checks"]) {
						found = found || obj(check)["action"] == ref["action"]
					}
					if !found {
						return nil, fault.New("hub_report_action_unavailable", 409)
					}
					if grant.Visibility == "Public" {
						public, e := s.Builders.EventPermittedWithin(ctx, tx, nil, r)
						if e != nil {
							return nil, e
						}
						if !public {
							return nil, fault.New("hub_report_not_public", 403)
						}
					}
				}
			}
			objectVersion = num(head, "version") + 1
			cv = objectVersion
		case "invite":
			if !owner || ev["memberId"] == a.SubjectID {
				return nil, fault.New("hub_operator_required", 403)
			}
			if e = pair(txt(ev, "memberId")); e != nil {
				return nil, e
			}
			_, c, e := s.current(ctx, tx, &a, txt(ev, "hubId"))
			if e != nil {
				return nil, e
			}
			cg, e := s.grant(ctx, tx, c)
			if e != nil {
				return nil, e
			}
			viewer := a
			viewer.SubjectID = txt(ev, "memberId")
			if !s.visible(cg, &viewer) {
				return nil, fault.New("hub_charter_not_visible_to_invitee", 403)
			}
			if num(ev, "charterVersion") != num(head, "version") {
				return nil, fault.New("hub_charter_changed", 409)
			}
			for _, scope := range arr(ev["scopes"]) {
				if !has(arr(obj(event(c)["charter"])["offeredScopes"]), scope) {
					return nil, fault.New("hub_charter_changed", 409)
				}
			}
			if num(ev, "expiresAt") <= s.now() || num(ev, "expiresAt") > min(grant.ExpiresAt, s.now()+2592000) {
				return nil, fault.New("hub_invitation_expiry", 400)
			}
			member, e := one(ctx, tx, "SELECT id FROM subjects WHERE id=$1", ev["memberId"])
			if e != nil {
				return nil, e
			}
			if member == nil {
				return nil, fault.New("hub_invitee_unavailable", 404)
			}
			existing, e := one(ctx, tx, "SELECT id FROM hub_memberships_v2 WHERE id=$1 OR (hub_id=$2 AND subject_id=$3 AND state IN ('invited','active'))", ev["membershipId"], ev["hubId"], ev["memberId"])
			if e != nil {
				return nil, e
			}
			if existing != nil {
				return nil, fault.New("hub_membership_exists", 409)
			}
			objectID = ev["membershipId"]
			objectVersion = 1
			cv = ev["charterVersion"]
		case "accept", "decline", "exit", "remove":
			m, e := one(ctx, tx, "SELECT * FROM hub_memberships_v2 WHERE id=$1 AND hub_id=$2 FOR UPDATE", ev["membershipId"], ev["hubId"])
			if e != nil {
				return nil, e
			}
			if m == nil {
				return nil, fault.New("hub_membership_unavailable", 404)
			}
			if kind == "remove" && !owner || kind != "remove" && a.SubjectID != m["subject_id"] {
				return nil, fault.New("hub_member_required", 403)
			}
			other := txt(head, "owner_id")
			if owner {
				other = txt(m, "subject_id")
			}
			if e = pair(other); e != nil {
				return nil, e
			}
			if num(ev, "expectedVersion") != num(m, "version") || num(ev, "charterVersion") != num(m, "charter_version") {
				return nil, fault.New("hub_membership_version_conflict", 409)
			}
			if kind == "accept" {
				view, e := s.membership(ctx, tx, a, head, txt(m, "id"))
				if e != nil {
					return nil, e
				}
				if m["state"] != "invited" || view["authorization"] != "awaiting-member-confirmation" {
					return nil, fault.New("hub_invitation_unavailable", 409)
				}
				scopes := arr(ev["acceptedScopes"])
				if len(scopes) == 0 {
					return nil, fault.New("hub_scope_expansion", 403)
				}
				for _, scope := range scopes {
					if !has(arr(m["scopes"]), scope) {
						return nil, fault.New("hub_scope_expansion", 403)
					}
				}
			} else {
				if ev["acceptedScopes"] != nil {
					return nil, fault.New("hub_unexpected_scope", 400)
				}
				allowed := m["state"] == "invited"
				if kind != "decline" {
					allowed = has([]any{"invited", "active"}, m["state"])
				}
				if !allowed {
					return nil, fault.New("hub_transition_denied", 409)
				}
			}
			objectID = m["id"]
			objectVersion = num(m, "version") + 1
			cv = m["charter_version"]
		case "suspend", "resume":
			if !owner {
				return nil, fault.New("hub_operator_required", 403)
			}
			if grant.Visibility != "Private" || len(grant.Viewers) != 0 {
				return nil, fault.New("hub_private_operator_required", 403)
			}
			previous := "active"
			if kind == "resume" {
				previous = "suspended"
			}
			if num(ev, "expectedVersion") != num(head, "version") || head["state"] != previous {
				return nil, fault.New("hub_transition_denied", 409)
			}
			if kind == "resume" {
				if _, e = s.charter(ctx, tx, &a, head, nil); e != nil {
					return nil, e
				}
				if _, e = s.registry(ctx, tx, &a, txt(ev, "hubId")); e != nil {
					return nil, e
				}
			}
			objectVersion = num(head, "version")
		default:
			objectID = ev["threadId"]
			if kind == "intake-open" {
				if owner {
					return nil, fault.New("hub_member_required", 403)
				}
				if _, e = s.charter(ctx, tx, &a, head, nil); e != nil {
					return nil, e
				}
				if e = pair(txt(head, "owner_id")); e != nil {
					return nil, e
				}
				prior, e := one(ctx, tx, "SELECT id FROM hub_intake_v2 WHERE id=$1", ev["threadId"])
				if e != nil {
					return nil, e
				}
				if prior != nil {
					return nil, fault.New("hub_intake_exists", 409)
				}
				objectVersion = 1
			} else {
				thread, e := one(ctx, tx, "SELECT * FROM hub_intake_v2 WHERE id=$1 AND hub_id=$2 FOR UPDATE", ev["threadId"], ev["hubId"])
				if e != nil {
					return nil, e
				}
				if thread == nil || !owner && a.SubjectID != thread["subject_id"] {
					return nil, fault.New("hub_intake_unavailable", 404)
				}
				other := txt(head, "owner_id")
				if owner {
					other = txt(thread, "subject_id")
				}
				if e = pair(other); e != nil {
					return nil, e
				}
				if thread["state"] != "open" || num(thread, "version") != num(ev, "expectedVersion") || num(thread, "expires_at") <= s.now() {
					return nil, fault.New("hub_intake_version_conflict", 409)
				}
				objectVersion = num(thread, "version") + 1
			}
		}
		row["hub_id"] = ev["hubId"]
		row["kind"] = kind
		row["object_id"] = objectID
		row["object_version"] = objectVersion
		row["charter_version"] = cv
		row["received_at"] = s.now()
		var intakeID any
		if has([]any{"intake-open", "intake-reply", "intake-close"}, kind) {
			intakeID = objectID
		}
		if _, e = tx.Exec(ctx, "INSERT INTO hub_events_v2(id,hub_id,subject_id,kind,charter_version,object_id,object_version,consent_id,payload_text,payload_hash,received_at,intake_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", row["id"], row["hub_id"], a.SubjectID, kind, cv, objectID, objectVersion, consent, payload, row["payload_hash"], row["received_at"], intakeID); e != nil {
			return nil, e
		}
		switch kind {
		case "charter":
			_, e = tx.Exec(ctx, "UPDATE hub_heads_v2 SET version=$2 WHERE id=$1", ev["hubId"], cv)
		case "invite":
			scopes, _ := protocol.Encode(ev["scopes"])
			_, e = tx.Exec(ctx, "INSERT INTO hub_memberships_v2(id,hub_id,subject_id,version,charter_version,state,scopes,invite_id,expires_at) VALUES($1,$2,$3,1,$4,'invited',$5::jsonb,$6,$7)", ev["membershipId"], ev["hubId"], ev["memberId"], cv, string(scopes), ev["id"], ev["expiresAt"])
		case "accept", "decline", "exit", "remove":
			var scopes any
			if ev["acceptedScopes"] != nil {
				raw, _ := protocol.Encode(ev["acceptedScopes"])
				scopes = string(raw)
			}
			_, e = tx.Exec(ctx, "UPDATE hub_memberships_v2 SET version=$2,state=$3,decision_id=$4,scopes=COALESCE($5::jsonb,scopes) WHERE id=$1", ev["membershipId"], objectVersion, map[string]string{"accept": "active", "decline": "declined", "exit": "exited", "remove": "removed"}[kind], ev["id"], scopes)
		case "suspend", "resume":
			state := "suspended"
			if kind == "resume" {
				state = "active"
			}
			_, e = tx.Exec(ctx, "UPDATE hub_heads_v2 SET state=$2 WHERE id=$1", ev["hubId"], state)
		case "intake-open":
			_, e = tx.Exec(ctx, "INSERT INTO hub_intake_v2(id,hub_id,subject_id,version,state,created_at,expires_at) VALUES($1,$2,$3,1,'open',$4,$5)", ev["threadId"], ev["hubId"], a.SubjectID, s.now(), s.now()+7776000)
		default:
			state := "open"
			if kind == "intake-close" {
				state = "closed"
			}
			_, e = tx.Exec(ctx, "UPDATE hub_intake_v2 SET version=$2,state=$3 WHERE id=$1", ev["threadId"], objectVersion, state)
		}
		if e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, row, requestID); e != nil {
			return nil, e
		}
		return receipt(row), nil
	})
}
