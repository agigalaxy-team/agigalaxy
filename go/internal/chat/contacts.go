package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"time"
)

type ContactService struct {
	Chat      *Service
	Discovery *ContactDiscovery
}

func (f *ContactService) run(ctx context.Context, a Actor, write bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	if f.Chat == nil || f.Chat.Devices == nil {
		return nil, fail("contact_service_unavailable", 503)
	}
	return postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		var authorization deviceauth.ControlAuthorization
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			var e error
			authorization, e = f.Chat.Devices.CurrentControlWithin(ctx, tx, *a.Device, "history")
			return e
		}
		if write {
			budget := f.Chat.Resources
			if budget == nil {
				budget, _ = resourcebudget.New(nil, f.Chat.Now)
			}
			result, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.Device.SubjectID}, authorize, func(_ context.Context, tx pgx.Tx) (any, error) { return fn(tx, authorization) }, resourcebudget.Options{})
			if e != nil {
				return nil, e
			}
			return result.(map[string]any), nil
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		return fn(tx, authorization)
	})
}
func (f *ContactService) state(r Object) string {
	if str(r, "state") == "sent" && millis(r["expires_at"]) <= f.Chat.now().UnixMilli() {
		return "expired"
	}
	return str(r, "state")
}
func (f *ContactService) receipt(r Object) Object {
	return Object{"schemaVersion": 2, "contactId": r["id"], "initiatorId": r["initiator_id"], "recipientId": r["recipient_id"], "purpose": r["purpose"], "state": f.state(r), "revision": r["revision"], "roomId": r["room_id"], "expiresAt": iso(r["expires_at"]), "sentMeaning": "accepted-by-galaxy-service; recipient-response-is-separate", "taskId": nil}
}
func (f *ContactService) require(ctx context.Context, tx pgx.Tx, a Actor, id string, write bool) (Object, error) {
	lock := " FOR SHARE"
	if write {
		lock = " FOR UPDATE"
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(c) FROM contacts_v2 c WHERE id=$1"+lock, id)
	if e != nil {
		return nil, e
	}
	if r == nil || str(r, "initiator_id") != a.Device.SubjectID && str(r, "recipient_id") != a.Device.SubjectID {
		return nil, fail("contact_not_found", 404)
	}
	return r, nil
}
func (f *ContactService) grant(ctx context.Context, tx pgx.Tx, r Object) (deviceauth.ConsentIntent, error) {
	if str(r, "payload_text") == "" {
		return deviceauth.ConsentIntent{}, fail("contact_source_unavailable", 404)
	}
	return f.Chat.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(r, "consent_id"), SubjectID: str(r, "subject_id"), Action: "contact.write", ObjectID: str(r, "operation_id"), Recipient: f.Chat.Endpoint, PayloadJSON: str(r, "payload_text")})
}
func contactProjection(v deviceauth.ConsentIntent, viewer string, now int64) bool {
	if v.IssuedAt > now || v.ExpiresAt <= now {
		return false
	}
	if viewer == v.SubjectID {
		return true
	}
	if v.CurrentVisibility != nil && v.CurrentVisibility.DeletionPending {
		return false
	}
	switch v.Visibility {
	case "Public":
		return v.Purpose == "public-profile"
	case "Private":
		return viewer != "" && has(v.Viewers, viewer)
	}
	return false
}
func (f *ContactService) read(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
	r, e := f.require(ctx, tx, a, id, false)
	if e != nil {
		return nil, e
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM contact_events_v2 e WHERE contact_id=$1 ORDER BY revision", id)
	if e != nil {
		return nil, e
	}
	events := []Object{}
	for _, event := range rr {
		meta := Object{"operationId": event["operation_id"], "subjectId": event["subject_id"], "kind": event["kind"], "revision": event["revision"], "recordedAt": iso(event["created_at"])}
		contents, e := func() (Object, error) {
			if millis(event["created_at"])+90*86400000 <= f.Chat.now().UnixMilli() {
				return nil, fail("contact_source_unavailable", 404)
			}
			grant, e := f.grant(ctx, tx, event)
			if e != nil {
				return nil, e
			}
			if !contactProjection(grant, a.Device.SubjectID, f.Chat.now().Unix()) {
				return nil, fail("contact_source_unavailable", 404)
			}
			payload, e := parseContactEvent([]byte(str(event, "payload_text")))
			if e != nil {
				return nil, e
			}
			out := Object{"note": payload["note"]}
			if str(payload, "kind") == "send" {
				out["opportunityRef"], out["context"], out["roomTitle"] = payload["opportunityRef"], payload["context"], payload["roomTitle"]
			}
			return out, nil
		}()
		if e != nil {
			if fault.Status(e) != 403 && fault.Status(e) != 404 {
				return nil, e
			}
			meta["contentUnavailable"] = true
		} else {
			for k, v := range contents {
				meta[k] = v
			}
		}
		events = append(events, meta)
	}
	out := f.receipt(r)
	out["events"] = events
	return out, nil
}
func (f *ContactService) Get(ctx context.Context, a Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, contactError()
	}
	return f.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) { return f.read(ctx, tx, a, id) })
}
func (f *ContactService) Query(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := loose(raw)
	if e != nil {
		return nil, contactError()
	}
	if _, ok := x["after"]; !ok {
		x["after"] = ""
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(50)
	}
	if _, ok := x["direction"]; !ok {
		x["direction"] = "both"
	}
	if !normalizeInteger(x, "limit", 1, 100) || !has([]string{"both", "incoming", "outgoing"}, str(x, "direction")) || str(x, "after") != "" && !validID(str(x, "after")) {
		return nil, contactError()
	}
	return f.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rr, e := rows(ctx, tx, "SELECT jsonb_build_object('id',id) FROM contacts_v2 WHERE (($2 IN ('both','incoming') AND recipient_id=$1) OR ($2 IN ('both','outgoing') AND initiator_id=$1)) AND ($3='' OR id::text>$3) ORDER BY id LIMIT $4", a.Device.SubjectID, x["direction"], str(x, "after"), num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for i, r := range rr {
			if int64(i) >= num(x, "limit") {
				break
			}
			view, e := f.read(ctx, tx, a, str(r, "id"))
			if e != nil {
				return nil, e
			}
			items = append(items, view)
		}
		var next any
		if int64(len(rr)) > num(x, "limit") {
			next = rr[num(x, "limit")-1]["id"]
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
func (f *ContactService) opportunity(ctx context.Context, tx pgx.Tx, initiator string, payload Object) error {
	if payload["recipientId"] != obj(payload, "opportunityRef")["subjectId"] {
		return fail("contact_recipient_mismatch", 400)
	}
	if f.Discovery == nil {
		return fail("contact_discovery_unavailable", 503)
	}
	return f.Discovery.RequireOpportunityWithin(ctx, tx, initiator, payload)
}
func (f *ContactService) contactAccount(ctx context.Context, tx pgx.Tx, subject string) error {
	if f.Chat.Links == nil {
		return fail("contact_room_adapter_unavailable", 503)
	}
	_, e := f.Chat.Links.ResolveContactAccountWithin(ctx, tx, subject, false)
	if e != nil {
		return e
	}
	return nil
}
func (f *ContactService) Submit(ctx context.Context, a Actor, raw []byte) (Object, error) {
	envelope, event, e := contactEnvelope(raw)
	if e != nil {
		return nil, e
	}
	text := str(envelope, "payloadJson")
	hash := identity.Digest([]byte(text))
	return f.run(ctx, a, true, func(tx pgx.Tx, authorization deviceauth.ControlAuthorization) (Object, error) {
		subject := a.Device.SubjectID
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912360))", event["contactId"]); e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM contact_events_v2 e WHERE operation_id=$1", event["operationId"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if str(prior, "subject_id") != subject || prior["contact_id"] != event["contactId"] || prior["consent_id"] != envelope["consentId"] || str(prior, "payload_hash") != hash {
				return nil, fail("contact_operation_conflict")
			}
			r, e := f.require(ctx, tx, a, str(event, "contactId"), false)
			if e != nil {
				return nil, e
			}
			out := f.receipt(r)
			out["operationId"], out["appliedRevision"], out["replayed"] = event["operationId"], prior["revision"], true
			return out, nil
		}
		grant, e := f.grant(ctx, tx, Object{"operation_id": event["operationId"], "subject_id": subject, "consent_id": envelope["consentId"], "payload_text": text})
		if e != nil {
			return nil, e
		}
		if grant.Visibility != "Private" || grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
			return nil, fail("contact_private_consent_required", 403)
		}
		var r, source Object
		counterparty := ""
		kind := str(event, "kind")
		if kind == "send" {
			if num(event, "expectedRevision") != 0 || str(event, "recipientId") == subject {
				return nil, contactError()
			}
			var exists bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM contacts_v2 WHERE id=$1)", event["contactId"]).Scan(&exists); e != nil {
				return nil, e
			}
			if exists {
				return nil, fail("contact_id_conflict")
			}
			counterparty = str(event, "recipientId")
			if e = f.opportunity(ctx, tx, subject, event); e != nil {
				return nil, e
			}
		} else {
			r, e = f.require(ctx, tx, a, str(event, "contactId"), true)
			if e != nil {
				return nil, e
			}
			counterparty = str(r, "initiator_id")
			if counterparty == subject {
				counterparty = str(r, "recipient_id")
			}
			if num(r, "revision") != num(event, "expectedRevision") {
				return nil, fail("contact_revision_conflict")
			}
			if f.state(r) != "sent" {
				return nil, fail("contact_not_awaiting_response")
			}
			if kind == "withdraw" && subject != str(r, "initiator_id") || kind != "withdraw" && subject != str(r, "recipient_id") {
				return nil, fail("contact_response_actor_denied", 403)
			}
			if kind == "accept" {
				source, e = row(ctx, tx, "SELECT to_jsonb(e) FROM contact_events_v2 e WHERE operation_id=$1", r["create_event_id"])
				if e != nil {
					return nil, e
				}
				original, e := f.grant(ctx, tx, source)
				if e != nil {
					return nil, e
				}
				if !contactProjection(original, str(r, "recipient_id"), f.Chat.now().Unix()) {
					return nil, fail("contact_source_unavailable", 403)
				}
				payload, e := parseContactEvent([]byte(str(source, "payload_text")))
				if e != nil {
					return nil, e
				}
				if e = f.opportunity(ctx, tx, str(r, "initiator_id"), payload); e != nil {
					return nil, e
				}
				for _, id := range []string{str(r, "initiator_id"), str(r, "recipient_id")} {
					if e = f.contactAccount(ctx, tx, id); e != nil {
						return nil, e
					}
				}
			}
		}
		if !contactProjection(grant, counterparty, f.Chat.now().Unix()) {
			return nil, fail("contact_recipient_consent_required", 403)
		}
		if kind == "send" {
			if _, e = f.Chat.publicWrites().ConsumeWithin(ctx, tx, publicwrites.Actor{Device: a.Device, AccountID: a.AccountID, Scope: "history"}, publicwrites.Operation{Kind: "invitation", OperationID: str(event, "operationId"), PayloadHash: hash, ContactID: str(event, "contactId"), RecipientID: str(event, "recipientId")}); e != nil {
				return nil, e
			}
		}
		revision := num(event, "expectedRevision") + 1
		if kind == "send" {
			if _, e = tx.Exec(ctx, `INSERT INTO contacts_v2(id,initiator_id,recipient_id,purpose,state,revision,create_event_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'sent',1,$5,$6,$7,$7)`, event["contactId"], subject, event["recipientId"], event["purpose"], event["operationId"], f.Chat.now().Add(7*24*time.Hour), f.Chat.now()); e != nil {
				return nil, e
			}
		}
		if _, e = tx.Exec(ctx, `INSERT INTO contact_events_v2(operation_id,contact_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, event["operationId"], event["contactId"], subject, revision, kind, envelope["consentId"], text, hash, f.Chat.now()); e != nil {
			return nil, e
		}
		if r != nil {
			state := map[string]string{"accept": "accepted", "decline": "declined", "withdraw": "withdrawn"}[kind]
			if _, e = tx.Exec(ctx, "UPDATE contacts_v2 SET state=$2,revision=$3,response_event_id=$4,updated_at=$5 WHERE id=$1", event["contactId"], state, revision, event["operationId"], f.Chat.now()); e != nil {
				return nil, e
			}
		}
		if kind == "accept" {
			payload, e := parseContactEvent([]byte(str(source, "payload_text")))
			if e != nil {
				return nil, e
			}
			room, e := f.CreateRoomWithin(ctx, tx, ContactRoom{ContactID: str(event, "contactId"), RoomID: str(event, "contactId"), InitiatorID: str(r, "initiator_id"), RecipientID: str(r, "recipient_id"), Title: str(payload, "roomTitle")})
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE contacts_v2 SET room_id=$2 WHERE id=$1", event["contactId"], room["roomId"]); e != nil {
				return nil, e
			}
		}
		if kind == "accept" || kind == "decline" {
			if e = f.Chat.publicWrites().MarkInvitationRespondedWithin(ctx, tx, publicwrites.Targets{ContactID: str(event, "contactId"), RecipientID: str(r, "recipient_id")}); e != nil {
				return nil, e
			}
		}
		if e = f.audit(ctx, tx, a, event, authorization); e != nil {
			return nil, e
		}
		current, e := f.require(ctx, tx, a, str(event, "contactId"), false)
		if e != nil {
			return nil, e
		}
		out := f.receipt(current)
		out["operationId"], out["appliedRevision"], out["replayed"] = event["operationId"], revision, false
		return out, nil
	})
}
