package taskmaterials

import (
	"context"
	"math"
	"math/big"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/jackc/pgx/v5"
)

func validTaskBudget(b Object) bool {
	if !trimmed(b, "unit", 24) {
		return false
	}
	switch str(b, "mode") {
	case "fixed":
		return exactFields(b, []string{"mode", "amount", "unit"}, nil) && decimal.MatchString(str(b, "amount"))
	case "quote":
		return exactFields(b, []string{"mode", "unit"}, nil)
	case "range":
		if !exactFields(b, []string{"mode", "minimum", "maximum", "unit"}, nil) || !decimal.MatchString(str(b, "minimum")) || !decimal.MatchString(str(b, "maximum")) {
			return false
		}
		low, _ := new(big.Rat).SetString(str(b, "minimum"))
		high, _ := new(big.Rat).SetString(str(b, "maximum"))
		return low.Cmp(high) <= 0
	}
	return false
}
func validUUIDList(value any, maximum int, unique bool) bool {
	values, ok := value.([]any)
	if !ok || len(values) > maximum {
		return false
	}
	seen := map[string]bool{}
	for _, v := range values {
		id, ok := v.(string)
		if !ok || !validID(id) || unique && seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}
func validFactReference(v Object) bool {
	return exactFields(v, []string{"id", "version"}, nil) && validID(str(v, "id")) && validInt(v["version"], 1, math.MaxInt64)
}
func validQualificationEvidence(v Object) bool {
	if exactFields(v, []string{"proofIds", "assistanceIds"}, nil) && validUUIDList(v["proofIds"], 16, true) && validUUIDList(v["assistanceIds"], 16, true) {
		return true
	}
	if !exactFields(v, nil, []string{"participationIds", "externalReviewRefs", "capsuleUseIds", "proofIds", "assistanceIds", "calculationGrantId"}) {
		return false
	}
	for _, key := range []string{"participationIds", "capsuleUseIds", "proofIds", "assistanceIds"} {
		if _, ok := v[key]; !ok {
			v[key] = []any{}
		}
		maximum := 32
		if key == "proofIds" || key == "assistanceIds" {
			maximum = 16
		}
		if !validUUIDList(v[key], maximum, false) {
			return false
		}
	}
	if _, ok := v["externalReviewRefs"]; !ok {
		v["externalReviewRefs"] = []any{}
	}
	refs, ok := v["externalReviewRefs"].([]any)
	if !ok || len(refs) > 32 {
		return false
	}
	for _, ref := range refs {
		r, ok := ref.(map[string]any)
		if !ok || !validFactReference(r) {
			return false
		}
	}
	if id, ok := v["calculationGrantId"]; ok && !validID(text(id)) {
		return false
	}
	return true
}
func parseTaskEvent(raw string) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_task_payload", 400) }
	if len([]byte(raw)) > 100000 {
		return invalid()
	}
	x, e := parseObject(raw)
	if e != nil || !exactFields(x, []string{"taskId", "event"}, nil) || !validID(str(x, "taskId")) {
		return invalid()
	}
	v := obj(x, "event")
	if !validID(str(v, "eventId")) || !validInt(v["expectedTaskVersion"], 1, math.MaxInt64) {
		return invalid()
	}
	required := []string{"eventId", "expectedTaskVersion", "kind"}
	optional := []string{}
	add := func(keys ...string) { required = append(required, keys...) }
	switch str(v, "kind") {
	case "suggest-contacts":
		add("state", "items")
		optional = append(optional, "error")
		if !contains([]string{"ready", "empty", "failed"}, str(v, "state")) {
			return invalid()
		}
		items, ok := v["items"].([]any)
		if !ok || len(items) > 32 {
			return invalid()
		}
		for _, item := range items {
			r, ok := item.(map[string]any)
			if !ok || !exactFields(r, []string{"subjectId", "help", "basis", "sourceRefs"}, []string{"conditions"}) || !subjectPattern.MatchString(str(r, "subjectId")) || !trimmed(r, "help", 1500) || !trimmed(r, "basis", 1500) {
				return invalid()
			}
			refs, ok := r["sourceRefs"].([]any)
			if !ok || len(refs) > 16 {
				return invalid()
			}
			for _, ref := range refs {
				if !validText(ref, 500) {
					return invalid()
				}
			}
			if _, ok := r["conditions"]; ok && !trimmed(r, "conditions", 1500) {
				return invalid()
			}
		}
		if _, ok := v["error"]; ok && !trimmed(v, "error", 1500) {
			return invalid()
		}
	case "invite":
		add("recipientId", "note", "expiresAt")
		if !subjectPattern.MatchString(str(v, "recipientId")) || !trimmed(v, "note", 1500) || !validInt(v["expiresAt"], 1, math.MaxInt64) {
			return invalid()
		}
	case "invitation-reply":
		add("invitationId", "response", "message")
		if !validID(str(v, "invitationId")) || !contains([]string{"question", "interested", "declined"}, str(v, "response")) || !trimmed(v, "message", 1500) {
			return invalid()
		}
	case "revoke-invitation":
		add("invitationId", "reason")
		if !validID(str(v, "invitationId")) || !trimmed(v, "reason", 1500) {
			return invalid()
		}
	case "apply":
		add("proposal")
		optional = append(optional, "scope", "quote", "qualificationEvidence")
		if !trimmed(v, "proposal", 1500) {
			return invalid()
		}
		if _, ok := v["scope"]; ok && !trimmed(v, "scope", 1500) {
			return invalid()
		}
		if _, ok := v["quote"]; ok && !validTaskBudget(obj(v, "quote")) {
			return invalid()
		}
		if _, ok := v["qualificationEvidence"]; ok && !validQualificationEvidence(obj(v, "qualificationEvidence")) {
			return invalid()
		}
	case "withdraw-application":
		add("applicationId", "reason")
		if !validID(str(v, "applicationId")) || !trimmed(v, "reason", 1500) {
			return invalid()
		}
	case "cancel", "stop-enrollment", "close":
		add("reason")
		if !trimmed(v, "reason", 1500) {
			return invalid()
		}
		if str(v, "kind") == "close" {
			optional = append(optional, "terminationIntent")
			if value, ok := v["terminationIntent"]; ok && value != "terminate-task" {
				return invalid()
			}
		}
	case "extend-enrollment":
		add("enrollmentExpiresAt")
		if !validInt(v["enrollmentExpiresAt"], 1, math.MaxInt64) {
			return invalid()
		}
	default:
		return invalid()
	}
	if !exactFields(v, required, optional) {
		return invalid()
	}
	return x, nil
}
func findObject(items any, key string, value any) Object {
	for _, item := range arr(items) {
		if v, ok := item.(map[string]any); ok && v[key] == value {
			return v
		}
	}
	return nil
}
func cloneObject(value Object) Object { v, _ := parseObject(string(jsonBytes(value))); return v }
func transition(ok bool, codes ...string) error {
	if ok {
		return nil
	}
	code := "task_transition_denied"
	if len(codes) > 0 {
		code = codes[0]
	}
	return fail(code)
}
func nextTask(state Object, actor string, event Object, now int64) (Object, error) {
	if e := transition(now >= num(state["lastEventAt"]) && now >= 0, "task_time_conflict"); e != nil {
		return nil, e
	}
	if len(arr(state["events"])) >= 10000 {
		return nil, fail("task_event_limit")
	}
	next := cloneObject(state)
	next["version"] = num(state["version"]) + 1
	next["lastEventAt"] = now
	next["events"] = append(arr(next["events"]), Object{"actorId": actor, "at": now, "event": event})
	return next, nil
}
func enrollmentOpen(state Object, now int64) bool {
	return str(state, "state") == "open" && str(obj(state, "enrollment"), "state") != "stopped" && num(obj(state, "request")["enrollmentExpiresAt"]) > now
}
func applyTaskEvent(state Object, actor string, event Object, now int64) (Object, error) {
	if num(event["expectedTaskVersion"]) != num(state["version"]) {
		return nil, fail("task_version_conflict")
	}
	next, e := nextTask(state, actor, event, now)
	if e != nil {
		return nil, e
	}
	requester := actor == str(state, "requesterId")
	inv := findObject(next["invitations"], "invitationId", event["invitationId"])
	deny := func(ok bool, code ...string) bool { e = transition(ok, code...); return e != nil }
	switch str(event, "kind") {
	case "suggest-contacts":
		if deny(requester) {
			break
		}
		items := arr(event["items"])
		if deny((str(event, "state") == "ready") == (len(items) > 0), "task_suggestions_state_mismatch") {
			break
		}
		seen := map[string]bool{}
		for _, v := range items {
			id := str(v.(map[string]any), "subjectId")
			if deny(!seen[id], "task_duplicate_suggestion") {
				break
			}
			seen[id] = true
		}
		if e != nil {
			break
		}
		suggestions := Object{"state": event["state"], "items": items, "eventId": event["eventId"], "updatedAt": now, "authority": "user-side-suggestion-not-response"}
		if value, ok := event["error"]; ok {
			suggestions["error"] = value
		}
		next["suggestions"] = suggestions
	case "invite":
		if deny(requester && enrollmentOpen(state, now) && str(event, "recipientId") != actor) {
			break
		}
		if deny(num(event["expiresAt"]) > now && num(event["expiresAt"]) <= min(now+7*86400, num(obj(state, "request")["enrollmentExpiresAt"])), "task_invitation_expiry") {
			break
		}
		for _, v := range arr(state["invitations"]) {
			prior := v.(map[string]any)
			if prior["recipientId"] != event["recipientId"] {
				continue
			}
			if deny(str(prior, "state") != "declined", "task_invitation_declined") || deny(str(prior, "state") != "pending" || num(prior["expiresAt"]) <= now, "task_invitation_pending") {
				break
			}
		}
		if e != nil {
			break
		}
		next["invitations"] = append(arr(next["invitations"]), Object{"invitationId": event["eventId"], "recipientId": event["recipientId"], "note": event["note"], "expiresAt": event["expiresAt"], "sentAt": now, "state": "pending", "replies": []any{}})
	case "invitation-reply":
		if deny(inv != nil && str(inv, "recipientId") == actor && !contains([]string{"revoked", "declined"}, str(inv, "state")) && num(inv["expiresAt"]) > now && !contains([]string{"canceled", "closed"}, str(state, "state"))) {
			break
		}
		inv["state"] = event["response"]
		inv["replies"] = append(arr(inv["replies"]), Object{"eventId": event["eventId"], "at": now, "response": event["response"], "message": event["message"]})
	case "revoke-invitation":
		if deny(requester && inv != nil && !contains([]string{"revoked", "declined"}, str(inv, "state"))) {
			break
		}
		inv["state"] = "revoked"
		inv["revocationEventId"] = event["eventId"]
	case "apply":
		if deny(!requester && enrollmentOpen(state, now)) {
			break
		}
		for _, v := range arr(state["applications"]) {
			p := v.(map[string]any)
			if deny(str(p, "subjectId") != actor || str(p, "state") != "pending", "task_application_pending") {
				break
			}
		}
		if e != nil {
			break
		}
		if deny(event["quote"] == nil || str(obj(state, "request"), "collaboration") == "basic-bounty") {
			break
		}
		application := Object{"applicationId": event["eventId"], "subjectId": actor, "proposal": event["proposal"], "quote": event["quote"], "qualificationEvidence": event["qualificationEvidence"], "state": "pending", "at": now}
		if application["qualificationEvidence"] == nil {
			application["qualificationEvidence"] = Object{"proofIds": []any{}, "assistanceIds": []any{}}
		}
		if value, ok := event["scope"]; ok {
			application["scope"] = value
		}
		next["applications"] = append(arr(next["applications"]), application)
	case "withdraw-application":
		application := findObject(next["applications"], "applicationId", event["applicationId"])
		if deny(application != nil && str(application, "subjectId") == actor && str(application, "state") == "pending") {
			break
		}
		application["state"] = "withdrawn"
		application["withdrawalEventId"] = event["eventId"]
	case "close":
		if deny(event["terminationIntent"] == "terminate-task", "task_termination_intent_required") {
			break
		}
		fallthrough
	case "cancel":
		if deny(requester && !contains([]string{"canceled", "closed"}, str(state, "state"))) {
			break
		}
		if str(event, "kind") == "close" {
			next["state"] = "closed"
		} else {
			next["state"] = "canceled"
		}
	case "stop-enrollment":
		if deny(requester && str(state, "state") == "open") {
			break
		}
		if str(obj(state, "enrollment"), "state") != "stopped" {
			next["enrollment"] = Object{"state": "stopped", "eventId": event["eventId"], "stoppedAt": now, "actorId": actor}
		}
	case "extend-enrollment":
		if deny(requester && str(state, "state") == "open" && str(obj(state, "enrollment"), "state") != "stopped" && num(event["enrollmentExpiresAt"]) > now && num(event["enrollmentExpiresAt"]) > num(obj(state, "request")["enrollmentExpiresAt"])) {
			break
		}
		obj(next, "request")["enrollmentExpiresAt"] = event["enrollmentExpiresAt"]
	}
	return next, e
}
func (s *Service) privateTaskGrant(ctx context.Context, tx pgx.Tx, a Actor, input Envelope, eventID string, recipients []string) error {
	g, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: input.ConsentID, SubjectID: a.SubjectID, Action: "assistance.publish", ObjectID: eventID, Recipient: s.Endpoint, PayloadJSON: input.PayloadJSON})
	if e != nil {
		return e
	}
	allowed := append([]string{a.SubjectID}, recipients...)
	if g.Visibility != "Private" {
		return fail("task_private_recipient_consent_required", 403)
	}
	for _, id := range g.Viewers {
		if !contains(allowed, id) {
			return fail("task_private_recipient_consent_required", 403)
		}
	}
	for _, id := range recipients {
		if !s.visible(g, id) {
			return fail("task_private_recipient_consent_required", 403)
		}
	}
	return nil
}
func (s *Service) SubmitTaskEvent(ctx context.Context, a Actor, id string, input Envelope) (any, error) {
	x, e := parseTaskEvent(input.PayloadJSON)
	if e != nil {
		return nil, e
	}
	if x["taskId"] != id {
		return nil, fail("task_target_mismatch", 400)
	}
	event := obj(x, "event")
	kind := str(event, "kind")
	return s.run(ctx, a, "assistance", true, contains([]string{"cancel", "close", "stop-enrollment", "withdraw-application", "revoke-invitation"}, kind), func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		access, e := s.RequireTaskWithin(ctx, tx, &a.Actor, id, true)
		if e != nil {
			return nil, e
		}
		if prior, e := taskReplay(ctx, tx, a, id, str(event, "eventId"), input.ConsentID, input.PayloadJSON); e != nil || prior != nil {
			return prior, e
		}
		if contains([]string{"invite", "apply", "extend-enrollment"}, kind) && contains(stringsOf(obj(access, "governance")["scopes"]), "new-participation-paused") {
			return nil, fail("target_operation_restricted")
		}
		if truth(access["paused"]) && !contains([]string{"cancel", "stop-enrollment", "withdraw-application", "revoke-invitation"}, kind) {
			return nil, fail("task_paused", 403)
		}
		state := obj(obj(access, "row"), "snapshot")
		next, e := applyTaskEvent(state, a.SubjectID, event, s.now())
		if e != nil {
			return nil, e
		}
		recipients := []string{str(access, "requesterId")}
		if kind == "invite" {
			recipients = append(recipients, str(event, "recipientId"))
		}
		if kind == "revoke-invitation" {
			recipients = append(recipients, str(findObject(state["invitations"], "invitationId", event["invitationId"]), "recipientId"))
		}
		if e = s.privateTaskGrant(ctx, tx, a, input, str(event, "eventId"), recipients); e != nil {
			return nil, e
		}
		var quota any
		if kind == "invite" {
			var exists bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM subjects WHERE id=$1)", event["recipientId"]).Scan(&exists); e != nil {
				return nil, e
			}
			if !exists {
				return nil, fail("invitation_recipient_unavailable", 403)
			}
			recipient := deviceauth.Actor{SubjectID: str(event, "recipientId")}
			if _, e = s.RequireTaskWithin(ctx, tx, &recipient, id, false); e != nil {
				return nil, e
			}
			if s.Writes == nil {
				return nil, fail("public_write_verification_unavailable", 503)
			}
			quota, e = s.Writes.ConsumeWithin(ctx, tx, publicwrites.Actor{Device: &a.Actor, Scope: "assistance"}, publicwrites.Operation{Kind: "invitation", OperationID: str(event, "eventId"), PayloadHash: identity.Digest([]byte(input.PayloadJSON)), TaskID: id, RecipientID: str(event, "recipientId")})
			if e != nil {
				return nil, e
			}
		}
		if kind == "invitation-reply" && s.Writes != nil {
			if e = s.Writes.MarkInvitationRespondedWithin(ctx, tx, publicwrites.Targets{TaskID: id, RecipientID: a.SubjectID}); e != nil {
				return nil, e
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE task_requests SET version=$2,snapshot=$3::jsonb WHERE id=$1", id, num(next["version"]), jsonBytes(next)); e != nil {
			return nil, e
		}
		receipt, e := s.recordTaskEvent(ctx, tx, a, auth, next, str(event, "eventId"), kind, input.ConsentID, input.PayloadJSON, nil)
		if e != nil {
			return nil, e
		}
		receipt["quota"] = quota
		return receipt, nil
	})
}
