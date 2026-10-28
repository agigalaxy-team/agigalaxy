package taskmaterials

import (
	"context"
	"encoding/base64"
	"errors"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/jackc/pgx/v5"
)

type SelectedSource struct {
	Source          Object
	AuthorID        string
	Size            int64
	Text            string
	Bytes           []byte
	Name, MediaType string
	ScanResult      any
}
type OutcomeService struct {
	*Service
	ReadMessage       func(context.Context, pgx.Tx, Actor, string, int64) (Object, error)
	RecheckMessage    func(context.Context, pgx.Tx, Actor, string, string, int64) (Object, error)
	SelectAttachment  func(context.Context, pgx.Tx, Actor, string) (SelectedSource, error)
	InspectAttachment func(context.Context, pgx.Tx, Actor, string) (Object, error)
	Store             attachments.Store
	Erase             func(context.Context, string) error
	Removals          *objectremoval.Service
}

func (o *OutcomeService) lock(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	mode := "SHARE"
	if write {
		mode = "UPDATE"
	}
	return row(ctx, tx, "SELECT to_jsonb(m) FROM outcome_materials_v2 m WHERE id=$1 FOR "+mode, id)
}
func outcomeOperation(ctx context.Context, tx pgx.Tx, id any) (Object, error) {
	return row(ctx, tx, "SELECT to_jsonb(e) FROM outcome_material_events_v2 e WHERE id=$1", id)
}
func (o *OutcomeService) state(m Object) string {
	if m["purged_at"] != nil {
		return "erased"
	}
	state := str(m, "state")
	if contains([]string{"declined", "cancelled", "revoked"}, state) {
		return state
	}
	if state == "requested" && millis(m["request_expires_at"]) <= o.now()*1000 {
		return "request-expired"
	}
	if m["expires_at"] != nil && millis(m["expires_at"]) <= o.now()*1000 {
		return "permission-expired"
	}
	return state
}
func (o *OutcomeService) view(m Object) Object {
	out := Object{"materialId": m["id"], "version": 1, "ownerId": m["subject_id"], "authorId": m["author_id"], "caseId": m["case_id"], "source": m["source"], "audience": m["audience"], "uses": m["uses"], "title": m["title"], "state": o.state(m), "revision": m["revision"], "requestExpiresAt": isoValue(m["request_expires_at"]), "approvedAt": isoValue(m["approved_at"]), "permissionExpiresAt": isoValue(m["expires_at"]), "size": num(m["byte_size"]), "sha256": m["sha256"], "cleanupPending": truth(m["purge_pending"]), "objectRemoved": m["purged_at"] != nil, "contentAvailable": false, "capabilityVerified": false, "sourceCopyIndependent": m["approval_id"] != nil, "retention": "independent-selected-material; original-chat-TTL-unchanged"}
	if m["task_id"] != nil {
		out["taskId"] = m["task_id"]
	}
	return out
}
func pending(ctx context.Context, tx pgx.Tx, subjects ...string) (bool, error) {
	var value bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=ANY($1::text[]) AND state IN ('requested','review-needed','approved','partial','primary-erased'))", subjects).Scan(&value)
	return value, e
}
func (o *OutcomeService) caseLive(ctx context.Context, tx pgx.Tx, id any) error {
	// Outcome's original records.caseWithin consumer needs only the current
	// locked container. It neither grants Case content nor creates a record.
	var parent Object
	var e error
	if o.CaseWithin != nil {
		var current Object
		current, e = o.CaseWithin(ctx, tx, text(id))
		parent = obj(current, "parent")
	} else {
		parent, e = row(ctx, tx, "SELECT to_jsonb(c) FROM cases c WHERE id=$1 FOR SHARE", id)
	}
	if e != nil {
		return e
	}
	if parent == nil {
		return fail("case_unavailable", 404)
	}
	blocked, e := pending(ctx, tx, str(parent, "subject_id"))
	if e != nil {
		return e
	}
	if str(parent, "state") == "withdrawn" || blocked {
		return fail("outcome_target_unavailable", 404)
	}
	return nil
}
func (o *OutcomeService) selected(ctx context.Context, tx pgx.Tx, a Actor, selection Object) (SelectedSource, error) {
	if str(selection, "kind") == "attachment" {
		if o.SelectAttachment == nil || o.Store == nil {
			return SelectedSource{}, fail("outcome_attachment_copy_unavailable", 503)
		}
		if num(selection["version"]) != 1 {
			return SelectedSource{}, fail("outcome_source_version_unavailable", 404)
		}
		return o.SelectAttachment(ctx, tx, a, str(selection, "id"))
	}
	if o.ReadMessage == nil {
		return SelectedSource{}, fail("outcome_message_source_unavailable", 503)
	}
	selected, e := o.ReadMessage(ctx, tx, a, str(selection, "id"), num(selection["version"]))
	if e != nil {
		return SelectedSource{}, e
	}
	body := str(selected, "text")
	return SelectedSource{Source: Object{"kind": "message", "id": selected["messageId"], "version": selected["revision"], "sha256": selected["contentHash"], "roomId": selected["roomId"]}, AuthorID: str(selected, "authorId"), Size: int64(len([]byte(body))), Text: body}, nil
}
func (o *OutcomeService) exactSource(ctx context.Context, tx pgx.Tx, a Actor, source Object) (SelectedSource, error) {
	value, e := o.selected(ctx, tx, a, source)
	if e != nil {
		return value, e
	}
	if canonical(value.Source) != canonical(source) {
		return value, fail("outcome_source_changed")
	}
	return value, nil
}
func (o *OutcomeService) Source(ctx context.Context, a Actor, kind, id string, version int64) (any, error) {
	if version == 0 {
		version = 1
	}
	if !contains([]string{"message", "attachment"}, kind) || !validID(id) || version < 1 {
		return nil, fail("invalid_outcome_material_request", 400)
	}
	return o.run(ctx, a, "evidence", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		selected, e := o.selected(ctx, tx, a, Object{"kind": kind, "id": id, "version": version})
		if e != nil {
			return nil, e
		}
		out := Object{"source": selected.Source, "authorId": selected.AuthorID, "size": selected.Size, "currentRoomReadOnly": true, "independentRetentionGranted": false}
		if kind == "attachment" {
			out["name"] = selected.Name
			out["mediaType"] = selected.MediaType
		}
		return out, nil
	})
}
func (o *OutcomeService) requireConsent(ctx context.Context, tx pgx.Tx, event Object) (deviceauth.ConsentIntent, error) {
	if event == nil || identity.Digest([]byte(str(event, "payload_text"))) != str(event, "payload_hash") {
		return deviceauth.ConsentIntent{}, fail("outcome_material_integrity_failed", 500)
	}
	grant, e := o.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(event, "consent_id"), SubjectID: str(event, "subject_id"), Action: "outcome.material", ObjectID: str(event, "id"), Recipient: o.Endpoint, PayloadJSON: str(event, "payload_text")})
	if e != nil {
		return grant, e
	}
	if grant.Visibility != "Private" || grant.Purpose != "operational" || grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
		return grant, fail("outcome_material_permission_unavailable", 403)
	}
	return grant, nil
}
func eventObject(a Actor, e outcomeEvent) Object {
	return Object{"id": e.Input["id"], "material_id": e.Input["materialId"], "subject_id": a.SubjectID, "consent_id": e.ConsentID, "payload_text": e.PayloadText, "payload_hash": e.PayloadHash}
}
func (o *OutcomeService) duplicate(ctx context.Context, tx pgx.Tx, a Actor, e outcomeEvent) (Object, error) {
	prior, err := outcomeOperation(ctx, tx, e.Input["id"])
	if err != nil || prior == nil {
		return nil, err
	}
	if str(prior, "subject_id") != a.SubjectID || str(prior, "material_id") != str(e.Input, "materialId") || str(prior, "payload_hash") != e.PayloadHash || str(prior, "consent_id") != e.ConsentID {
		return nil, fail("outcome_material_operation_conflict")
	}
	m, err := o.lock(ctx, tx, str(prior, "material_id"), false)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, fail("outcome_material_unavailable", 404)
	}
	out := o.view(m)
	out["operationId"] = prior["id"]
	out["operationState"] = "recorded"
	out["replayed"] = true
	return out, nil
}
func serializeOutcome(ctx context.Context, tx pgx.Tx, x Object) error {
	keys := []string{"operation:" + str(x, "id"), "material:" + str(x, "materialId")}
	sort.Strings(keys)
	for _, key := range keys {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912323,hashtext($1))", key); e != nil {
			return e
		}
	}
	return nil
}
func (o *OutcomeService) append(ctx context.Context, tx pgx.Tx, a Actor, e outcomeEvent, revision any, auth deviceauth.ControlAuthorization) error {
	if _, err := tx.Exec(ctx, `INSERT INTO outcome_material_events_v2(id,material_id,subject_id,kind,revision,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, e.Input["id"], e.Input["materialId"], a.SubjectID, e.Input["kind"], num(revision), e.ConsentID, e.PayloadText, e.PayloadHash, stamp(o.now())); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'evidence',c.id,b.id,$5,$4,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$8 AND c.subject_id=$1`, a.SubjectID, "outcome-material."+str(e.Input, "kind"), e.Input["materialId"], e.Input["id"], a.HTTPRequestID, jsonBytes(auth.CredentialScopes), a.BindingID, e.ConsentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fail("outcome_material_audit_context_unavailable", 503)
	}
	return nil
}
func (o *OutcomeService) Request(ctx context.Context, a Actor, input Envelope) (any, error) {
	e, err := parseOutcome(input, "request")
	if err != nil {
		return nil, err
	}
	x := e.Input
	return o.run(ctx, a, "evidence", true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if err := serializeOutcome(ctx, tx, x); err != nil {
			return nil, err
		}
		if prior, err := o.duplicate(ctx, tx, a, e); err != nil || prior != nil {
			return prior, err
		}
		existing, err := o.lock(ctx, tx, str(x, "materialId"), false)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			return nil, fail("outcome_material_conflict")
		}
		intent, err := o.requireConsent(ctx, tx, eventObject(a, e))
		if err != nil {
			return nil, err
		}
		expires := millis(x["requestExpiresAt"])
		if expires <= o.now()*1000 || expires > min(intent.ExpiresAt, o.now()+30*86400)*1000 {
			return nil, fail("outcome_request_expiry_invalid")
		}
		if err = o.caseLive(ctx, tx, x["caseId"]); err != nil {
			return nil, err
		}
		selected, err := o.exactSource(ctx, tx, a, obj(x, "source"))
		if err != nil {
			return nil, err
		}
		blocked, err := pending(ctx, tx, a.SubjectID, selected.AuthorID)
		if err != nil {
			return nil, err
		}
		if blocked {
			return nil, fail("outcome_material_permission_unavailable", 403)
		}
		if selected.AuthorID != a.SubjectID && !contains(intent.Viewers, selected.AuthorID) {
			return nil, fail("outcome_author_preview_permission_required", 403)
		}
		m, err := row(ctx, tx, `INSERT INTO outcome_materials_v2(id,subject_id,author_id,case_id,task_id,source,source_kind,audience,uses,title,request_id,state,created_at,request_expires_at,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,'requested',$12,$13,$14,$15) RETURNING to_jsonb(outcome_materials_v2)`, x["materialId"], a.SubjectID, selected.AuthorID, x["caseId"], x["taskId"], jsonBytes(x["source"]), obj(x, "source")["kind"], jsonBytes(x["audience"]), jsonBytes(x["uses"]), x["title"], x["id"], stamp(o.now()), x["requestExpiresAt"], selected.Size, obj(x, "source")["sha256"])
		if err != nil {
			return nil, err
		}
		if str(m, "source_kind") == "attachment" && o.Removals != nil && o.Store != nil {
			d := outcomeRemovalDescriptor(m)
			d.StorageKey = "outcome-materials/" + str(m, "id")
			d.KeyID = o.Store.KeyID()
			if err = o.Removals.RegisterNewObjectWithin(ctx, tx, d); err != nil {
				return nil, err
			}
		}
		if err = o.append(ctx, tx, a, e, m["revision"], auth); err != nil {
			return nil, err
		}
		out := o.view(m)
		out["operationId"] = x["id"]
		out["operationState"] = "recorded"
		out["requestHash"] = e.PayloadHash
		return out, nil
	})
}
func (o *OutcomeService) Approve(ctx context.Context, a Actor, input Envelope) (any, error) {
	e, err := parseOutcome(input, "approve")
	if err != nil {
		return nil, err
	}
	x := e.Input
	return o.run(ctx, a, "evidence", true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if err := serializeOutcome(ctx, tx, x); err != nil {
			return nil, err
		}
		if prior, err := o.duplicate(ctx, tx, a, e); err != nil || prior != nil {
			return prior, err
		}
		m, err := o.lock(ctx, tx, str(x, "materialId"), true)
		if err != nil {
			return nil, err
		}
		if m == nil || str(m, "author_id") != a.SubjectID {
			return nil, fail("outcome_material_unavailable", 404)
		}
		if num(m["revision"]) != num(x["expectedRevision"]) || o.state(m) != "requested" {
			return nil, fail("outcome_material_revision_conflict")
		}
		request, err := outcomeOperation(ctx, tx, m["request_id"])
		if err != nil {
			return nil, err
		}
		if request == nil || str(request, "payload_hash") != str(x, "requestHash") || canonical(x["source"]) != canonical(m["source"]) {
			return nil, fail("outcome_material_request_mismatch")
		}
		if _, err = o.requireConsent(ctx, tx, request); err != nil {
			return nil, err
		}
		intent, err := o.requireConsent(ctx, tx, eventObject(a, e))
		if err != nil {
			return nil, err
		}
		if str(m, "subject_id") != a.SubjectID && !contains(intent.Viewers, str(m, "subject_id")) {
			return nil, fail("outcome_requester_preview_permission_required", 403)
		}
		if x["expiresAt"] != nil && millis(x["expiresAt"]) <= o.now()*1000 {
			return nil, fail("outcome_permission_expiry_invalid")
		}
		if err = o.caseLive(ctx, tx, m["case_id"]); err != nil {
			return nil, err
		}
		selected, err := o.exactSource(ctx, tx, a, obj(m, "source"))
		if err != nil {
			return nil, err
		}
		if selected.AuthorID != str(m, "author_id") || selected.Size != num(m["byte_size"]) {
			return nil, fail("outcome_source_changed")
		}
		var storageKey, keyID any
		if str(m, "source_kind") == "attachment" {
			if o.Store == nil {
				return nil, fail("outcome_attachment_copy_unavailable", 503)
			}
			key := "outcome-materials/" + str(x, "materialId")
			if err = o.Store.Put(ctx, key, selected.Bytes, str(selected.Source, "sha256")); err != nil {
				return nil, err
			}
			storageKey = key
			keyID = o.Store.KeyID()
		}
		name, media := selected.Name, selected.MediaType
		if name == "" {
			name = str(obj(x, "source"), "kind")
		}
		if media == "" {
			media = "text/plain"
		}
		var scanResult any
		if selected.ScanResult != nil {
			scanResult = jsonBytes(selected.ScanResult)
		}
		updated, err := row(ctx, tx, `UPDATE outcome_materials_v2 SET state='available',approval_id=$2,revision=revision+1,approved_at=$3,expires_at=$4,body_text=$5,name=$6,media_type=$7,storage_key=$8,encryption_key_id=$9,scan_result=$10::jsonb,last_error=NULL WHERE id=$1 RETURNING to_jsonb(outcome_materials_v2)`, x["materialId"], x["id"], stamp(o.now()), x["expiresAt"], selected.Text, name, media, storageKey, keyID, scanResult)
		if err != nil {
			return nil, err
		}
		if err = o.append(ctx, tx, a, e, updated["revision"], auth); err != nil {
			return nil, err
		}
		out := o.view(updated)
		out["operationId"] = x["id"]
		out["operationState"] = "recorded"
		out["copyStored"] = true
		return out, nil
	})
}
func (o *OutcomeService) Control(ctx context.Context, a Actor, input Envelope) (any, error) {
	e, err := parseOutcome(input, "decline", "cancel", "revoke")
	if err != nil {
		return nil, err
	}
	x := e.Input
	return o.run(ctx, a, "evidence", true, true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if err := serializeOutcome(ctx, tx, x); err != nil {
			return nil, err
		}
		if prior, err := o.duplicate(ctx, tx, a, e); err != nil || prior != nil {
			return prior, err
		}
		m, err := o.lock(ctx, tx, str(x, "materialId"), true)
		if err != nil {
			return nil, err
		}
		if m == nil || !contains([]string{str(m, "subject_id"), str(m, "author_id")}, a.SubjectID) {
			return nil, fail("outcome_material_unavailable", 404)
		}
		if num(m["revision"]) != num(x["expectedRevision"]) {
			return nil, fail("outcome_material_revision_conflict")
		}
		kind := str(x, "kind")
		if kind == "decline" && a.SubjectID != str(m, "author_id") || kind == "cancel" && a.SubjectID != str(m, "subject_id") {
			return nil, fail("outcome_material_action_not_allowed", 403)
		}
		if kind != "revoke" && str(m, "state") != "requested" || kind == "revoke" && !contains([]string{"available", "copying", "copy-failed"}, str(m, "state")) {
			return nil, fail("outcome_material_action_not_allowed")
		}
		if _, err = o.requireConsent(ctx, tx, eventObject(a, e)); err != nil {
			return nil, err
		}
		state := map[string]string{"revoke": "revoked", "decline": "declined", "cancel": "cancelled"}[kind]
		updated, err := row(ctx, tx, "UPDATE outcome_materials_v2 SET state=$2,revision=revision+1,purge_pending=true WHERE id=$1 RETURNING to_jsonb(outcome_materials_v2)", x["materialId"], state)
		if err != nil {
			return nil, err
		}
		if err = o.append(ctx, tx, a, e, updated["revision"], auth); err != nil {
			return nil, err
		}
		out := o.view(updated)
		out["operationId"] = x["id"]
		out["operationState"] = "recorded"
		return out, nil
	})
}
func (o *OutcomeService) live(ctx context.Context, tx pgx.Tx, m Object) error {
	if o.state(m) != "available" || truth(m["purge_pending"]) {
		return fail("outcome_material_unavailable", 404)
	}
	request, e := outcomeOperation(ctx, tx, m["request_id"])
	if e != nil {
		return e
	}
	approval, e := outcomeOperation(ctx, tx, m["approval_id"])
	if e != nil {
		return e
	}
	if request == nil || approval == nil {
		return fail("outcome_material_permission_unavailable", 404)
	}
	if _, e = o.requireConsent(ctx, tx, request); e != nil {
		return e
	}
	if _, e = o.requireConsent(ctx, tx, approval); e != nil {
		return e
	}
	if e = o.caseLive(ctx, tx, m["case_id"]); e != nil {
		return e
	}
	blocked, e := pending(ctx, tx, str(m, "subject_id"), str(m, "author_id"))
	if e != nil {
		return e
	}
	if blocked {
		return fail("outcome_material_unavailable", 404)
	}
	return nil
}
func (o *OutcomeService) ReadWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
	return o.readViewerWithin(ctx, tx, a.SubjectID, id)
}
func (o *OutcomeService) readViewerWithin(ctx context.Context, tx pgx.Tx, viewer, id string) (Object, error) {
	m, e := o.lock(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	if m == nil {
		return nil, fail("outcome_material_unavailable", 404)
	}
	party := contains([]string{str(m, "subject_id"), str(m, "author_id")}, viewer)
	audience := obj(m, "audience")
	if !party && str(audience, "visibility") != "Public" && !contains(stringsOf(audience["viewers"]), viewer) {
		return nil, fail("outcome_material_unavailable", 404)
	}
	unavailable := func(e error) (Object, error) {
		var serviceError *fault.Error
		if !errors.As(e, &serviceError) {
			return nil, e
		}
		if !party {
			return nil, fail("outcome_material_unavailable", 404)
		}
		out := o.view(m)
		out["availability"] = "unavailable"
		out["reason"] = fault.Code(e)
		return out, nil
	}
	if e = o.live(ctx, tx, m); e != nil {
		return unavailable(e)
	}
	content := str(m, "body_text")
	bytesBase64 := ""
	if str(m, "source_kind") == "attachment" {
		if o.Store == nil || str(m, "storage_key") == "" {
			return unavailable(fail("outcome_material_storage_unavailable", 503))
		}
		bytes, e := o.Store.Get(ctx, str(m, "storage_key"), str(m, "encryption_key_id"), num(m["byte_size"]))
		if e != nil {
			return unavailable(e)
		}
		if bytes == nil || identity.Digest(bytes) != str(m, "sha256") {
			return unavailable(fail("outcome_material_integrity_failed", 500))
		}
		bytesBase64 = base64.StdEncoding.EncodeToString(bytes)
	} else if identity.Digest([]byte(content)) != str(m, "sha256") {
		return unavailable(fail("outcome_material_integrity_failed", 500))
	}
	if e = o.live(ctx, tx, m); e != nil {
		return unavailable(e)
	}
	if o.state(m) != "available" || truth(m["purge_pending"]) {
		return unavailable(fail("outcome_material_unavailable", 404))
	}
	out := o.view(m)
	if str(m, "source_kind") == "attachment" {
		out["bytesBase64"] = bytesBase64
	} else {
		out["content"] = content
	}
	out["contentAvailable"] = true
	out["authorization"] = "current"
	return out, nil
}
func (o *OutcomeService) Read(ctx context.Context, a Actor, id string) (any, error) {
	if !validID(id) {
		return nil, fail("invalid_outcome_material_request", 400)
	}
	return o.run(ctx, a, "evidence", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) { return o.ReadWithin(ctx, tx, a, id) })
}
