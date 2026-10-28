package taskmaterials

import (
	"context"
	"math"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

type DeliveryInput struct {
	TaskID, CaseID, ParticipationID, SubjectID string
	ScopeVersion                               int64
	ResultRef                                  Object
	InterventionRefs                           []Object
	EvidenceRefs                               []any
}

func parseParticipation(raw string, proposal bool) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_task_payload", 400) }
	if len([]byte(raw)) > 100000 {
		return invalid()
	}
	v, e := parseObject(raw)
	if e != nil || !validID(str(v, "eventId")) {
		return invalid()
	}
	if proposal {
		if !exactFields(v, []string{"eventId", "expectedTaskVersion", "kind", "participationId", "subjectId", "role", "scopeVersion", "agreedScope"}, []string{"applicationId"}) || !validInt(v["expectedTaskVersion"], 1, math.MaxInt64) || v["kind"] != "propose" || !validID(str(v, "participationId")) || !subjectPattern.MatchString(str(v, "subjectId")) || !contains([]string{"contribution", "diagnosis", "advice", "context", "tool", "patch", "review", "verification", "takeover", "main-responsible"}, str(v, "role")) || !validInt(v["scopeVersion"], 1, 1) || !trimmed(v, "agreedScope", 3002) {
			return invalid()
		}
		if id, ok := v["applicationId"]; ok && !validID(text(id)) {
			return invalid()
		}
		return v, nil
	}
	if !validInt(v["expectedParticipationVersion"], 1, math.MaxInt64) {
		return invalid()
	}
	required := []string{"eventId", "expectedParticipationVersion", "kind"}
	optional := []string{}
	add := func(keys ...string) { required = append(required, keys...) }
	switch str(v, "kind") {
	case "requester-feedback":
		add("descriptionClarity", "scopeMatched", "note")
		optional = append(optional, "supersedes", "reason")
		if !contains([]string{"clear", "partly-clear", "unclear"}, str(v, "descriptionClarity")) || !trimmed(v, "note", 1500) {
			return invalid()
		}
		if _, ok := v["scopeMatched"].(bool); !ok {
			return invalid()
		}
		if _, ok := v["supersedes"]; ok && !validID(str(v, "supersedes")) {
			return invalid()
		}
		if _, ok := v["reason"]; ok && !trimmed(v, "reason", 1500) {
			return invalid()
		}
	case "confirm":
		add("scopeVersion")
		if !validInt(v["scopeVersion"], 1, math.MaxInt64) {
			return invalid()
		}
	case "decline", "withdraw", "dispute":
		add("reason")
		if !trimmed(v, "reason", 1500) {
			return invalid()
		}
	case "propose-scope":
		add("scopeVersion", "agreedScope", "reason")
		if !validInt(v["scopeVersion"], 1, math.MaxInt64) || !trimmed(v, "agreedScope", 3002) || !trimmed(v, "reason", 1500) {
			return invalid()
		}
	case "confirm-scope", "confirm-resolution":
		add("proposalId")
		if !validID(str(v, "proposalId")) {
			return invalid()
		}
	case "decline-scope":
		add("proposalId", "reason")
		if !validID(str(v, "proposalId")) || !trimmed(v, "reason", 1500) {
			return invalid()
		}
	case "deliver":
		add("resultRef", "interventionRefs", "evidenceRefs", "summary")
		if !validFactReference(obj(v, "resultRef")) || !trimmed(v, "summary", 1500) {
			return invalid()
		}
		for _, key := range []string{"interventionRefs", "evidenceRefs"} {
			refs, ok := v[key].([]any)
			if !ok || len(refs) > 32 {
				return invalid()
			}
			for _, ref := range refs {
				if id, ok := ref.(string); ok && key == "evidenceRefs" && validID(id) {
					continue
				}
				r, ok := ref.(map[string]any)
				if !ok || !validFactReference(r) {
					return invalid()
				}
			}
		}
	case "accept":
		add("deliveryId", "summary")
		if !validID(str(v, "deliveryId")) || !trimmed(v, "summary", 1500) {
			return invalid()
		}
	case "propose-resolution":
		add("summary", "outcome")
		if !trimmed(v, "summary", 1500) || !contains([]string{"close", "resume-work"}, str(v, "outcome")) {
			return invalid()
		}
	default:
		return invalid()
	}
	if !exactFields(v, required, optional) {
		return invalid()
	}
	return v, nil
}
func proposeParticipation(state Object, actor string, event Object, now int64) (Object, Object, error) {
	if e := transition(actor == str(state, "requesterId") && str(event, "subjectId") != actor && enrollmentOpen(state, now)); e != nil {
		return nil, nil, e
	}
	if num(event["expectedTaskVersion"]) != num(state["version"]) {
		return nil, nil, fail("task_version_conflict")
	}
	for _, id := range arr(state["participationIds"]) {
		if id == event["participationId"] {
			return nil, nil, fail("participation_conflict")
		}
	}
	if id, ok := event["applicationId"]; ok {
		application := findObject(state["applications"], "applicationId", id)
		if application == nil || application["subjectId"] != event["subjectId"] || application["state"] != "pending" {
			return nil, nil, fail("task_application_unavailable")
		}
	}
	taskEvent := cloneObject(event)
	taskEvent["kind"] = "participation-proposed"
	next, e := nextTask(state, actor, taskEvent, now)
	if e != nil {
		return nil, nil, e
	}
	next["participationIds"] = append(arr(next["participationIds"]), event["participationId"])
	if id, ok := event["applicationId"]; ok {
		findObject(next["applications"], "applicationId", id)["state"] = "selected"
	}
	p := Object{"schemaVersion": 2, "taskId": obj(state, "request")["taskId"], "participationId": event["participationId"], "subjectId": event["subjectId"], "requesterId": state["requesterId"], "role": event["role"], "scopeVersion": 1, "agreedScope": event["agreedScope"], "scopeEventId": event["eventId"], "state": "awaiting-counterparty", "version": 1, "proposalEventId": event["eventId"], "applicationId": event["applicationId"], "confirmedAt": nil, "pendingScope": nil, "deliveries": []any{}, "dispute": nil, "disputeResolution": nil, "events": []any{Object{"actorId": actor, "at": now, "event": event}}, "createdAt": now, "lastEventAt": now, "contextAccessGranted": false, "roomMembershipGranted": false, "paymentExecuted": false, "verification": "not-provided", "resolution": "unresolved"}
	return next, p, nil
}
func applyParticipation(task, state Object, actor string, event Object, now int64) (Object, Object, error) {
	if num(event["expectedParticipationVersion"]) != num(state["version"]) {
		return nil, nil, fail("participation_version_conflict")
	}
	requester, provider := actor == str(state, "requesterId"), actor == str(state, "subjectId")
	if !requester && !provider {
		return nil, nil, fail("participation_actor_denied")
	}
	if now < num(state["lastEventAt"]) || now < 0 {
		return nil, nil, fail("participation_time_conflict")
	}
	kind := str(event, "kind")
	if contains([]string{"canceled", "closed"}, str(task, "state")) && !contains([]string{"withdraw", "dispute", "propose-resolution", "confirm-resolution", "requester-feedback"}, kind) {
		return nil, nil, fail("task_closed")
	}
	next := cloneObject(state)
	var e error
	deny := func(ok bool, codes ...string) bool {
		code := "task_transition_denied"
		if len(codes) > 0 {
			code = codes[0]
		}
		e = transition(ok, code)
		return e != nil
	}
	switch kind {
	case "requester-feedback":
		if deny(provider && state["confirmedAt"] != nil && (contains([]string{"accepted", "withdrawn", "closed"}, str(state, "state")) || contains([]string{"canceled", "closed"}, str(task, "state"))), "requester_feedback_not_available") {
			break
		}
		if feedback := obj(state, "feedback"); feedback != nil {
			if deny(event["supersedes"] == feedback["eventId"] && str(event, "reason") != "", "requester_feedback_revision_required") {
				break
			}
		} else if deny(event["supersedes"] == nil, "requester_feedback_source_unavailable") {
			break
		}
		next["feedback"] = Object{"eventId": event["eventId"], "descriptionClarity": event["descriptionClarity"], "scopeMatched": event["scopeMatched"], "note": event["note"], "authority": "provider-reported", "independentQualityRating": false}
	case "confirm":
		if deny(provider && str(state, "state") == "awaiting-counterparty" && num(event["scopeVersion"]) == num(state["scopeVersion"])) {
			break
		}
		next["state"] = "active"
		next["confirmedAt"] = now
	case "decline":
		if deny(provider && str(state, "state") == "awaiting-counterparty") {
			break
		}
		next["state"] = "declined"
	case "withdraw":
		if deny(provider && contains([]string{"awaiting-counterparty", "active", "delivered", "accepted", "disputed"}, str(state, "state"))) {
			break
		}
		next["state"] = "withdrawn"
		next["withdrawnAt"] = now
	case "propose-scope":
		if deny(requester && contains([]string{"active", "delivered", "accepted"}, str(state, "state")) && state["pendingScope"] == nil) {
			break
		}
		if deny(num(event["scopeVersion"]) == num(state["scopeVersion"])+1, "participation_scope_conflict") {
			break
		}
		next["pendingScope"] = Object{"eventId": event["eventId"], "scopeVersion": event["scopeVersion"], "agreedScope": event["agreedScope"], "reason": event["reason"]}
	case "confirm-scope":
		pending := obj(state, "pendingScope")
		if deny(provider && pending != nil && pending["eventId"] == event["proposalId"]) {
			break
		}
		next["agreedScope"] = pending["agreedScope"]
		next["scopeVersion"] = pending["scopeVersion"]
		next["scopeEventId"] = pending["eventId"]
		next["pendingScope"] = nil
		next["state"] = "active"
	case "decline-scope":
		pending := obj(state, "pendingScope")
		if deny(provider && pending != nil && pending["eventId"] == event["proposalId"]) {
			break
		}
		next["pendingScope"] = nil
	case "deliver":
		if deny(provider && contains([]string{"active", "delivered", "accepted"}, str(state, "state"))) {
			break
		}
		if deny(obj(task, "request")["caseId"] != nil, "task_case_required_for_facts") {
			break
		}
		next["deliveries"] = append(arr(next["deliveries"]), Object{"deliveryId": event["eventId"], "resultRef": event["resultRef"], "interventionRefs": event["interventionRefs"], "evidenceRefs": event["evidenceRefs"], "summary": event["summary"], "scopeVersion": state["scopeVersion"], "authorId": actor, "at": now, "acceptance": nil, "verification": "not-provided", "resolution": "unresolved"})
		next["state"] = "delivered"
	case "accept":
		delivery := findObject(next["deliveries"], "deliveryId", event["deliveryId"])
		if deny(requester && contains([]string{"delivered", "accepted", "withdrawn"}, str(state, "state")) && delivery != nil && delivery["acceptance"] == nil) {
			break
		}
		delivery["acceptance"] = Object{"eventId": event["eventId"], "actorId": actor, "at": now, "summary": event["summary"]}
		deliveries := arr(next["deliveries"])
		if str(state, "state") != "withdrawn" && deliveries[len(deliveries)-1].(map[string]any)["deliveryId"] == delivery["deliveryId"] {
			next["state"] = "accepted"
		}
	case "dispute":
		if deny(state["confirmedAt"] != nil && !contains([]string{"declined", "awaiting-counterparty"}, str(state, "state"))) {
			break
		}
		next["dispute"] = Object{"eventId": event["eventId"], "actorId": actor, "reason": event["reason"], "previousState": state["state"]}
		next["disputeResolution"] = nil
		next["state"] = "disputed"
	case "propose-resolution":
		if deny(str(state, "state") == "disputed") {
			break
		}
		next["disputeResolution"] = Object{"eventId": event["eventId"], "actorId": actor, "summary": event["summary"], "outcome": event["outcome"], "confirmation": nil}
	case "confirm-resolution":
		resolution := obj(next, "disputeResolution")
		if deny(str(state, "state") == "disputed" && resolution != nil && resolution["eventId"] == event["proposalId"] && resolution["actorId"] != actor) {
			break
		}
		resolution["confirmation"] = Object{"eventId": event["eventId"], "actorId": actor, "at": now}
		next["state"] = "closed"
		if resolution["outcome"] == "resume-work" {
			next["state"] = "active"
		}
	}
	if e != nil {
		return nil, nil, e
	}
	next["version"] = num(state["version"]) + 1
	next["lastEventAt"] = now
	next["events"] = append(arr(next["events"]), Object{"actorId": actor, "at": now, "event": event})
	taskEvent := cloneObject(event)
	taskEvent["participationId"] = state["participationId"]
	nextTask, e := nextTask(task, actor, taskEvent, now)
	return nextTask, next, e
}
func (s *Service) participationQualification(ctx context.Context, tx pgx.Tx, a Actor, task, participation Object) error {
	if obj(task, "request")["qualification"] == nil {
		return nil
	}
	if s.ValidateParticipationQualification == nil {
		return fail("qualification_unavailable", 503)
	}
	return s.ValidateParticipationQualification(ctx, tx, a, task, participation)
}
func saveParticipation(ctx context.Context, tx pgx.Tx, p Object) error {
	tag, e := tx.Exec(ctx, `INSERT INTO task_participations(id,task_id,subject_id,version,snapshot)VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id)DO UPDATE SET version=EXCLUDED.version,snapshot=EXCLUDED.snapshot WHERE task_participations.task_id=EXCLUDED.task_id AND task_participations.subject_id=EXCLUDED.subject_id`, p["participationId"], p["taskId"], p["subjectId"], num(p["version"]), jsonBytes(p))
	if e == nil && tag.RowsAffected() != 1 {
		return fail("participation_conflict")
	}
	return e
}
func saveTask(ctx context.Context, tx pgx.Tx, task Object) error {
	_, e := tx.Exec(ctx, "UPDATE task_requests SET version=$2,snapshot=$3::jsonb,case_id=$4 WHERE id=$1", obj(task, "request")["taskId"], num(task["version"]), jsonBytes(task), obj(task, "request")["caseId"])
	return e
}
func (s *Service) ProposeParticipation(ctx context.Context, a Actor, taskID string, input Envelope) (any, error) {
	event, e := parseParticipation(input.PayloadJSON, true)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "assistance", true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		access, e := s.RequireTaskWithin(ctx, tx, &a.Actor, taskID, true)
		if e != nil {
			return nil, e
		}
		if prior, e := taskReplay(ctx, tx, a, taskID, str(event, "eventId"), input.ConsentID, input.PayloadJSON); e != nil || prior != nil {
			return prior, e
		}
		if contains(stringsOf(obj(access, "governance")["scopes"]), "new-participation-paused") {
			return nil, fail("target_operation_restricted")
		}
		if truth(access["paused"]) {
			return nil, fail("task_paused", 403)
		}
		prior, e := row(ctx, tx, "SELECT to_jsonb(p) FROM task_participations p WHERE id=$1", event["participationId"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			return nil, fail("participation_conflict")
		}
		task, participation, e := proposeParticipation(obj(obj(access, "row"), "snapshot"), a.SubjectID, event, s.now())
		if e != nil {
			return nil, e
		}
		recipient := deviceauth.Actor{SubjectID: str(event, "subjectId")}
		if _, e = s.RequireTaskWithin(ctx, tx, &recipient, taskID, false); e != nil {
			return nil, e
		}
		if e = s.privateTaskGrant(ctx, tx, a, input, str(event, "eventId"), []string{recipient.SubjectID}); e != nil {
			return nil, e
		}
		peers, e := rows(ctx, tx, "SELECT to_jsonb(p) FROM task_participations p WHERE task_id=$1", taskID)
		if e != nil {
			return nil, e
		}
		for _, p := range peers {
			state := obj(p, "snapshot")
			if p["subject_id"] == event["subjectId"] && state["role"] == event["role"] && !contains([]string{"declined", "withdrawn", "closed"}, str(state, "state")) {
				return nil, fail("participation_already_exists")
			}
		}
		if e = s.participationQualification(ctx, tx, a, task, participation); e != nil {
			return nil, e
		}
		if e = saveParticipation(ctx, tx, participation); e != nil {
			return nil, e
		}
		if e = saveTask(ctx, tx, task); e != nil {
			return nil, e
		}
		return s.recordTaskEvent(ctx, tx, a, auth, task, str(event, "eventId"), "participation-proposed", input.ConsentID, input.PayloadJSON, participation)
	})
}
func (s *Service) SubmitParticipationEvent(ctx context.Context, a Actor, id string, input Envelope) (any, error) {
	event, e := parseParticipation(input.PayloadJSON, false)
	if e != nil {
		return nil, e
	}
	kind := str(event, "kind")
	return s.run(ctx, a, "assistance", true, contains([]string{"decline", "withdraw", "dispute", "requester-feedback"}, kind), func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		located, e := row(ctx, tx, "SELECT to_jsonb(p) FROM task_participations p WHERE id=$1", id)
		if e != nil {
			return nil, e
		}
		if located == nil {
			return nil, fail("not_found", 404)
		}
		taskID := str(located, "task_id")
		access, e := s.RequireTaskWithin(ctx, tx, &a.Actor, taskID, true)
		if e != nil {
			return nil, e
		}
		if prior, e := taskReplay(ctx, tx, a, taskID, str(event, "eventId"), input.ConsentID, input.PayloadJSON); e != nil || prior != nil {
			return prior, e
		}
		if truth(access["paused"]) && !contains([]string{"decline", "withdraw", "dispute", "requester-feedback"}, kind) {
			return nil, fail("task_paused", 403)
		}
		prior, e := s.RequireParticipationWithin(ctx, tx, a.Actor, taskID, id, true)
		if e != nil {
			return nil, e
		}
		if kind == "confirm" && prior["confirmedAt"] == nil && contains(stringsOf(obj(access, "governance")["scopes"]), "new-participation-paused") {
			return nil, fail("target_operation_restricted")
		}
		delete(prior, "paused")
		delete(prior, "taskState")
		task, participation, e := applyParticipation(obj(obj(access, "row"), "snapshot"), prior, a.SubjectID, event, s.now())
		if e != nil {
			return nil, e
		}
		if e = s.privateTaskGrant(ctx, tx, a, input, str(event, "eventId"), []string{str(prior, "requesterId"), str(prior, "subjectId")}); e != nil {
			return nil, e
		}
		if kind == "confirm" || kind == "confirm-scope" {
			if e = s.participationQualification(ctx, tx, a, task, participation); e != nil {
				return nil, e
			}
		}
		if kind == "deliver" || kind == "accept" {
			if s.ValidateDelivery == nil {
				return nil, fail("task_fact_validation_unavailable", 503)
			}
			delivery := event
			if kind == "accept" {
				delivery = findObject(prior["deliveries"], "deliveryId", event["deliveryId"])
			}
			scopeVersion := num(prior["scopeVersion"])
			if delivery["scopeVersion"] != nil {
				scopeVersion = num(delivery["scopeVersion"])
			}
			refs := []Object{}
			for _, ref := range arr(delivery["interventionRefs"]) {
				refs = append(refs, ref.(map[string]any))
			}
			if e = s.ValidateDelivery(ctx, tx, a, DeliveryInput{TaskID: taskID, CaseID: str(obj(access, "row"), "case_id"), ParticipationID: id, SubjectID: str(prior, "subjectId"), ScopeVersion: scopeVersion, ResultRef: obj(delivery, "resultRef"), InterventionRefs: refs, EvidenceRefs: arr(delivery["evidenceRefs"])}); e != nil {
				return nil, e
			}
		}
		if e = saveParticipation(ctx, tx, participation); e != nil {
			return nil, e
		}
		if e = saveTask(ctx, tx, task); e != nil {
			return nil, e
		}
		if kind == "confirm" || kind == "accept" {
			links := s.Links
			if links == nil && s.Writes != nil {
				links = s.Writes.Links
			}
			if links != nil {
				sourceKind := "accepted-participation"
				if kind == "accept" {
					sourceKind = "accepted-delivery"
				}
				for _, pair := range [][2]string{{str(prior, "requesterId"), str(prior, "subjectId")}, {str(prior, "subjectId"), str(prior, "requesterId")}} {
					if e = links.RecordInteractionWithin(ctx, tx, accountlinks.Interaction{SubjectID: pair[0], CounterpartyID: pair[1], SourceID: str(event, "eventId"), SourceKind: sourceKind}); e != nil {
						return nil, e
					}
				}
			}
		}
		return s.recordTaskEvent(ctx, tx, a, auth, task, str(event, "eventId"), kind, input.ConsentID, input.PayloadJSON, participation)
	})
}
