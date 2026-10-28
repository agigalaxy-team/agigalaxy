package taskmaterials

import (
	"context"
	"math"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func ownerReadGuarantees(out Object) Object {
	out["projection"] = "currently-authorized-authored-events"
	for _, key := range []string{"completeTaskSnapshot", "contextAccessGranted", "referenceAccessGranted", "taskWriteGranted"} {
		out[key] = false
	}
	return out
}
func ownerCurrent(a Actor, auth deviceauth.ControlAuthorization) (Object, error) {
	if auth.DeviceID == nil || *auth.DeviceID == "" || auth.Epoch == 0 {
		return nil, fail("task_owner_read_control_required", 403)
	}
	return Object{"bindingId": a.BindingID, "deviceId": *auth.DeviceID, "controlEpoch": auth.Epoch}, nil
}
func ownerSourceUnavailable() error { return fail("task_owner_read_source_unavailable", 403) }

// ownerSource is the original recovery-only retention check. It does not call
// the revoked Task grant or mint replacement authority for any other consumer.
func (s *Service) ownerSource(ctx context.Context, tx pgx.Tx, a Actor, taskID string, eventIDs []string, control Object) (Object, []Object, error) {
	task, e := row(ctx, tx, `SELECT jsonb_build_object('id',id,'requester_id',requester_id,'root_event_id',root_event_id,'version',version,'case_id',case_id,'content_deleted',COALESCE((snapshot->>'contentDeleted')::boolean,false)) FROM task_requests WHERE id=$1 AND requester_id=$2 FOR SHARE`, taskID, a.SubjectID)
	if e != nil {
		return nil, nil, e
	}
	if task == nil {
		return nil, nil, fail("not_found", 404)
	}
	if truth(task["content_deleted"]) {
		return nil, nil, ownerSourceUnavailable()
	}
	var deleting bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", a.SubjectID).Scan(&deleting); e != nil {
		return nil, nil, e
	}
	if deleting {
		return nil, nil, ownerSourceUnavailable()
	}
	if task["case_id"] != nil {
		parent, e := row(ctx, tx, "SELECT to_jsonb(c) FROM cases c WHERE id=$1 AND subject_id=$2 FOR SHARE", task["case_id"], a.SubjectID)
		if e != nil {
			return nil, nil, e
		}
		if parent == nil || parent["state"] == "withdrawn" {
			return nil, nil, ownerSourceUnavailable()
		}
	}
	ids := []string{str(task, "root_event_id")}
	for _, id := range eventIDs {
		if !contains(ids, id) {
			ids = append(ids, id)
		}
	}
	events, e := rows(ctx, tx, `SELECT jsonb_build_object('id',id,'version',version,'kind',kind,'payload_hash',payload_hash,'created_at',created_at,'consent_id',consent_id,'content_retained',length(payload_text)>0) FROM task_events WHERE task_id=$1 AND subject_id=$2 AND id=ANY($3::uuid[]) ORDER BY version`, taskID, a.SubjectID, ids)
	if e != nil {
		return nil, nil, e
	}
	if len(events) != len(ids) {
		return nil, nil, fail("not_found", 404)
	}
	for _, event := range events {
		if !truth(event["content_retained"]) {
			return nil, nil, ownerSourceUnavailable()
		}
		original, e := row(ctx, tx, `SELECT to_jsonb(c)||jsonb_build_object('device_id',b.device_id,'control_epoch',b.control_epoch,'binding_expires_at',b.expires_at,'binding_revoked_at',b.revoked_at) FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.id=$1 AND c.subject_id=$2 AND b.subject_id=$2 AND b.audience=$3 FOR SHARE OF c`, event["consent_id"], a.SubjectID, s.Endpoint)
		if e != nil {
			return nil, nil, e
		}
		intent := obj(original, "intent")
		if original == nil || original["revoked_at"] != nil || intent["action"] != "assistance.publish" || intent["objectId"] != event["id"] || intent["recipient"] != s.Endpoint || intent["payloadHash"] != event["payload_hash"] || original["binding_revoked_at"] == nil || str(original, "device_id") == "" || num(original["control_epoch"]) == 0 || num(original["control_epoch"]) >= num(control["controlEpoch"]) {
			return nil, nil, ownerSourceUnavailable()
		}
		recovery, e := row(ctx, tx, `SELECT to_jsonb(r) FROM subject_control_events r JOIN device_authorizations d ON d.subject_id=r.subject_id AND d.device_id=$2 AND d.epoch=$3 WHERE r.subject_id=$1 AND r.kind='recover' AND r.epoch=$3+1 AND r.accepted_at=$4::timestamptz AND d.status='revoked' AND d.revoked_at=r.accepted_at AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.actor=$1 AND a.action='binding.revoke' AND a.object_id=$5 AND a.outcome='accepted')`, a.SubjectID, original["device_id"], original["control_epoch"], original["binding_revoked_at"], original["binding_id"])
		if e != nil {
			return nil, nil, e
		}
		if recovery == nil || millis(original["binding_expires_at"]) <= millis(recovery["accepted_at"]) {
			return nil, nil, ownerSourceUnavailable()
		}
		revocations, e := rows(ctx, tx, `SELECT jsonb_build_object('payload_text',payload_text) FROM subject_control_events WHERE subject_id=$1 AND epoch=$2 AND kind='revoke-device' AND sequence<$3`, a.SubjectID, original["control_epoch"], recovery["sequence"])
		if e != nil {
			return nil, nil, e
		}
		for _, revocation := range revocations {
			payload, e := parseObject(str(revocation, "payload_text"))
			request := obj(payload, "request")
			if e != nil || request["kind"] != "revoke-device" || str(request, "deviceId") == "" {
				return nil, nil, fail("task_owner_read_integrity_error", 500)
			}
			if request["deviceId"] == original["device_id"] {
				return nil, nil, ownerSourceUnavailable()
			}
		}
		expires := min(millis(original["expires_at"]), num(intent["expiresAt"])*1000)
		if contains([]string{"suggest-contacts", "invite", "invitation-reply", "apply", "withdraw-application", "revoke-invitation"}, str(event, "kind")) {
			expires = min(expires, millis(event["created_at"])+90*86400*1000)
		}
		if expires <= s.now()*1000 {
			return nil, nil, ownerSourceUnavailable()
		}
		event["readExpiresAt"] = expires / 1000
	}
	return task, events, nil
}
func taskOrdered(fields ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(fields); i += 2 {
		o.Set(fields[i].(string), fields[i+1])
	}
	return o
}
func eventReferences(events []Object) []any {
	refs := []any{}
	for _, e := range events {
		refs = append(refs, taskOrdered("eventId", e["id"], "version", e["version"], "payloadHash", e["payload_hash"]))
	}
	return refs
}
func (s *Service) OwnerReadPrepare(ctx context.Context, a Actor, input Object) (any, error) {
	if !exactFields(input, []string{"taskId", "operationId"}, []string{"eventIds"}) || !validID(str(input, "taskId")) || !validID(str(input, "operationId")) {
		return nil, fail("invalid_task_owner_read", 400)
	}
	ids := []string{}
	if value, ok := input["eventIds"]; ok {
		if !validUUIDList(value, 32, false) || len(arr(value)) == 0 {
			return nil, fail("invalid_task_owner_read", 400)
		}
		for _, id := range arr(value) {
			ids = append(ids, text(id))
		}
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		control, e := ownerCurrent(a, auth)
		if e != nil {
			return nil, e
		}
		task, events, e := s.ownerSource(ctx, tx, a, str(input, "taskId"), ids, control)
		if e != nil {
			return nil, e
		}
		expires := s.now() + 3600
		metadata := []any{}
		for _, event := range events {
			expires = min(expires, num(event["readExpiresAt"]))
			metadata = append(metadata, Object{"eventId": event["id"], "version": event["version"], "kind": event["kind"], "payloadHash": event["payload_hash"], "createdAt": isoValue(event["created_at"]), "readExpiresAt": event["readExpiresAt"]})
		}
		descriptor := taskOrdered("version", 1, "operationId", input["operationId"], "taskId", task["id"], "taskVersion", task["version"], "bindingId", control["bindingId"], "deviceId", control["deviceId"], "controlEpoch", control["controlEpoch"], "eventRefs", eventReferences(events), "expiresAt", expires)
		payload := string(jsonBytes(descriptor))
		return ownerReadGuarantees(Object{"taskId": task["id"], "latestTaskVersion": task["version"], "payloadJson": payload, "payloadHash": identity.Digest([]byte(payload)), "expiresAt": expires, "events": metadata}), nil
	})
}
func parseOwnerDescriptor(input Envelope) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_task_owner_read", 400) }
	if !validID(input.ConsentID) || !validText(input.PayloadJSON, 20000) {
		return invalid()
	}
	v, e := parseObject(input.PayloadJSON)
	if e != nil || !exactFields(v, []string{"version", "operationId", "taskId", "taskVersion", "bindingId", "deviceId", "controlEpoch", "eventRefs", "expiresAt"}, nil) || !validInt(v["version"], 1, 1) {
		return invalid()
	}
	for _, key := range []string{"operationId", "taskId", "bindingId", "deviceId"} {
		if !validID(str(v, key)) {
			return invalid()
		}
	}
	for _, key := range []string{"taskVersion", "controlEpoch", "expiresAt"} {
		if !validInt(v[key], 1, math.MaxInt64) {
			return invalid()
		}
	}
	refs, ok := v["eventRefs"].([]any)
	if !ok || len(refs) < 1 || len(refs) > 33 {
		return invalid()
	}
	for _, value := range refs {
		ref, ok := value.(map[string]any)
		if !ok || !exactFields(ref, []string{"eventId", "version", "payloadHash"}, nil) || !validID(str(ref, "eventId")) || !validInt(ref["version"], 1, math.MaxInt64) || !hashPattern.MatchString(str(ref, "payloadHash")) {
			return invalid()
		}
	}
	return v, nil
}
func (s *Service) OwnerRead(ctx context.Context, a Actor, taskID string, input Envelope) (any, error) {
	descriptor, e := parseOwnerDescriptor(input)
	if e != nil {
		return nil, e
	}
	if descriptor["taskId"] != taskID {
		return nil, fail("task_owner_read_scope_mismatch", 403)
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		control, e := ownerCurrent(a, auth)
		if e != nil {
			return nil, e
		}
		for key, value := range control {
			if key == "controlEpoch" {
				if num(descriptor[key]) != num(value) {
					return nil, fail("task_owner_read_scope_mismatch", 403)
				}
			} else if descriptor[key] != value {
				return nil, fail("task_owner_read_scope_mismatch", 403)
			}
		}
		if num(descriptor["expiresAt"]) <= s.now() || num(descriptor["expiresAt"]) > s.now()+3600 {
			return nil, fail("task_owner_read_scope_mismatch", 403)
		}
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: input.ConsentID, SubjectID: a.SubjectID, Action: "task.owner-read", ObjectID: str(descriptor, "operationId"), Recipient: s.Endpoint, PayloadJSON: input.PayloadJSON})
		if e != nil {
			return nil, e
		}
		if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
			return nil, ownerSourceUnavailable()
		}
		consent, e := row(ctx, tx, "SELECT to_jsonb(c) FROM consents c WHERE id=$1", input.ConsentID)
		if e != nil {
			return nil, e
		}
		if consent == nil || consent["binding_id"] != control["bindingId"] || grant.BindingID != control["bindingId"] || grant.Visibility != "Private" || len(grant.Viewers) != 0 || grant.Purpose != "operational" || grant.ExpiresAt != num(descriptor["expiresAt"]) || len(grant.Fields) != len(descriptor) {
			return nil, fail("task_owner_read_scope_mismatch", 403)
		}
		for key := range descriptor {
			if !contains(grant.Fields, key) {
				return nil, fail("task_owner_read_scope_mismatch", 403)
			}
		}
		ids := []string{}
		for _, ref := range arr(descriptor["eventRefs"]) {
			ids = append(ids, str(ref.(map[string]any), "eventId"))
		}
		task, events, e := s.ownerSource(ctx, tx, a, taskID, ids, control)
		if e != nil {
			return nil, e
		}
		actual := []Object{}
		for _, event := range events {
			actual = append(actual, Object{"eventId": event["id"], "version": event["version"], "payloadHash": event["payload_hash"]})
			if num(descriptor["expiresAt"]) > num(event["readExpiresAt"]) {
				return nil, fail("task_owner_read_preview_changed")
			}
		}
		if num(task["version"]) != num(descriptor["taskVersion"]) || canonical(actual) != canonical(descriptor["eventRefs"]) {
			return nil, fail("task_owner_read_preview_changed")
		}
		body, e := rows(ctx, tx, "SELECT jsonb_build_object('id',id,'payload_text',payload_text) FROM task_events WHERE task_id=$1 AND subject_id=$2 AND id=ANY($3::uuid[])", taskID, a.SubjectID, ids)
		if e != nil {
			return nil, e
		}
		contents := map[string]string{}
		for _, r := range body {
			contents[str(r, "id")] = str(r, "payload_text")
		}
		out := []any{}
		for _, event := range events {
			payload := contents[str(event, "id")]
			if identity.Digest([]byte(payload)) != event["payload_hash"] {
				return nil, fail("task_owner_read_integrity_error", 500)
			}
			if _, e := parseObject(payload); e != nil {
				return nil, fail("task_owner_read_integrity_error", 500)
			}
			out = append(out, Object{"eventId": event["id"], "version": event["version"], "kind": event["kind"], "payloadHash": event["payload_hash"], "payloadJson": payload})
		}
		return ownerReadGuarantees(Object{"taskId": taskID, "latestTaskVersion": task["version"], "events": out}), nil
	})
}
