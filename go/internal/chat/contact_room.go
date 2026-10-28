package chat

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

type ContactRoom struct{ ContactID, RoomID, InitiatorID, RecipientID, Title string }

// CreateRoomWithin is the original signed contact's atomic accepted-room seam.
// ContactService has proved both choices before updating the accepted row.
func (f *ContactService) CreateRoomWithin(ctx context.Context, tx pgx.Tx, input ContactRoom) (Object, error) {
	contact, e := row(ctx, tx, "SELECT to_jsonb(c) FROM contacts_v2 c WHERE id=$1 FOR UPDATE", input.ContactID)
	if e != nil {
		return nil, e
	}
	if contact == nil || str(contact, "state") != "accepted" || contact["response_event_id"] == nil || str(contact, "initiator_id") != input.InitiatorID || str(contact, "recipient_id") != input.RecipientID {
		return nil, fail("contact_room_authorization_required", 403)
	}
	hash := canonical(Object{"kind": "contact-room", "contactId": input.ContactID, "roomId": input.RoomID, "initiatorId": input.InitiatorID, "recipientId": input.RecipientID, "title": input.Title})
	old, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM chat_rooms r WHERE room_id=$1 OR (creator_subject_id=$2 AND operation_id=$3) FOR UPDATE", input.RoomID, input.InitiatorID, input.ContactID)
	if e != nil {
		return nil, e
	}
	if len(old) > 0 {
		if len(old) != 1 || str(old[0], "room_id") != input.RoomID || str(old[0], "operation_id") != input.ContactID || str(old[0], "creator_subject_id") != input.InitiatorID || str(old[0], "request_hash") != hash {
			return nil, fail("contact_room_conflict")
		}
		return Object{"roomId": input.RoomID, "replayed": true}, nil
	}
	members := []string{input.InitiatorID, input.RecipientID}
	parties := []string{}
	controllers := []string{}
	for _, id := range members {
		if e = f.contactAccount(ctx, tx, id); e != nil {
			return nil, e
		}
		party, e := f.Chat.Links.ResolveControlPartyWithin(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		if party == "" {
			return nil, fail("chat_control_relationship_unavailable", 503)
		}
		controllers = append(controllers, party)
		if !has(parties, party) {
			parties = append(parties, party)
		}
	}
	multiple := len(parties) > 1
	state := "waiting-members"
	if multiple {
		state = "active"
	}
	if _, e = tx.Exec(ctx, `INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,state,mode,retention_days,revision,member_revision,had_multiple,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'ownerless',90,2,2,$7,$8,$8)`, input.RoomID, input.InitiatorID, input.ContactID, hash, input.Title, state, multiple, f.Chat.now()); e != nil {
		return nil, e
	}
	for i, id := range members {
		if _, e = tx.Exec(ctx, "INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)", input.RoomID, id, controllers[i], f.Chat.now()); e != nil {
			return nil, e
		}
	}
	current, e := f.Chat.requireRoomRef(ctx, tx, input.RecipientID, input.RoomID, true, false)
	if e != nil {
		return nil, e
	}
	return Object{"roomId": input.RoomID, "independentMemberCount": len(current.Parties), "replayed": false}, nil
}
func (f *ContactService) audit(ctx context.Context, tx pgx.Tx, a Actor, event Object, authorization deviceauth.ControlAuthorization) error {
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,'contact.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'history',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=(SELECT consent_id FROM contact_events_v2 WHERE operation_id=$2::text::uuid AND subject_id=$1) AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action='contact.event' AND object_id=$2::text)`, a.Device.SubjectID, event["operationId"], null(a.RequestID), encode(authorization.CredentialScopes), a.Device.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE actor=$1 AND action='contact.event' AND object_id=$2", a.Device.SubjectID, event["operationId"]).Scan(&count); e != nil {
		return e
	}
	if count != 1 {
		return fmt.Errorf("audit context unavailable")
	}
	return nil
}
