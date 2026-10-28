package taskmaterials

import (
	"context"
	"math"
	"math/big"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/jackc/pgx/v5"
)

type TaskSubmission struct {
	ConsentID      string   `json:"consentId,omitempty"`
	SignedIntent   *string  `json:"signedIntent,omitempty"`
	PayloadJSON    string   `json:"payloadJson"`
	MaterialBodies []Object `json:"materialBodies,omitempty"`
}

var capability = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)
var decimal = regexp.MustCompile(`^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$`)

func validateTaskText(parent Object, key string, maximum int, single bool) bool {
	value := parent[key]
	if _, ok := value.(string); ok {
		return trimmed(parent, key, maximum)
	}
	v, ok := value.(map[string]any)
	if !ok || !exactFields(v, []string{"format", "segments"}, nil) || str(v, "format") != "task-text-v1" {
		return false
	}
	segments, ok := v["segments"].([]any)
	limit := 8
	if single {
		limit = 1
	}
	if !ok || len(segments) < 1 || len(segments) > limit {
		return false
	}
	material := false
	literal := ""
	for _, s := range segments {
		segment, ok := s.(map[string]any)
		if !ok {
			return false
		}
		switch str(segment, "kind") {
		case "literal":
			if !exactFields(segment, []string{"kind", "text"}, nil) || !validText(segment["text"], 10000) {
				return false
			}
			literal += str(segment, "text")
		case "material":
			if !exactFields(segment, []string{"kind", "materialId"}, nil) || !validID(str(segment, "materialId")) {
				return false
			}
			material = true
		default:
			return false
		}
	}
	return material || jsTrim(literal) != "" && protocol.TextLength(literal) <= maximum
}
func parseTask(raw string) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_task_payload", 400) }
	if len([]byte(raw)) > 100000 {
		return invalid()
	}
	v, e := parseObject(raw)
	if e != nil {
		return invalid()
	}
	caseID, provided := v["caseId"]
	if !provided {
		v["caseId"] = nil
	}
	copy := Object{}
	for k, value := range v {
		if k != "caseId" {
			copy[k] = value
		}
	}
	if !exactFields(copy, []string{"operationId", "taskId", "intent", "workContext", "title", "summary", "visibility", "collaboration", "enrollmentExpiresAt"}, []string{"parentTaskId", "expectedOutcome", "materials", "budget", "capabilityId", "qualification"}) || !validID(str(v, "operationId")) || !validID(str(v, "taskId")) || caseID != nil && !validID(text(caseID)) || !contains([]string{"stuck", "proactive-review", "diagnosis", "collaboration", "delegation"}, str(v, "intent")) || !contains([]string{"Public", "Private"}, str(v, "visibility")) || !contains([]string{"open-assistance", "basic-bounty"}, str(v, "collaboration")) || !validInt(v["enrollmentExpiresAt"], 1, math.MaxInt64) || !validateTaskText(v, "title", 120, true) || !validateTaskText(v, "summary", 10000, false) {
		return invalid()
	}
	if _, ok := v["expectedOutcome"]; ok && !validateTaskText(v, "expectedOutcome", 1500, false) {
		return invalid()
	}
	if value, ok := v["parentTaskId"]; ok && !validID(text(value)) {
		return invalid()
	}
	work := obj(v, "workContext")
	if work == nil {
		return invalid()
	}
	if _, ok := work["attemptRefs"]; !ok {
		work["attemptRefs"] = []any{}
	}
	if !exactFields(work, []string{"goal", "currentSituation", "attemptRefs"}, nil) || !validateTaskText(work, "goal", 10000, false) || !validateTaskText(work, "currentSituation", 10000, false) {
		return invalid()
	}
	refs, ok := work["attemptRefs"].([]any)
	if !ok || len(refs) > 32 {
		return invalid()
	}
	for _, r := range refs {
		ref, ok := r.(map[string]any)
		if !ok || !exactFields(ref, []string{"id", "version"}, nil) || !validID(str(ref, "id")) || !validInt(ref["version"], 1, math.MaxInt64) {
			return invalid()
		}
	}
	if value, ok := v["capabilityId"]; ok && !capability.MatchString(text(value)) {
		return invalid()
	}
	qualification, hasQualification := v["qualification"]
	if hasQualification {
		q, ok := qualification.(map[string]any)
		if !ok || !exactFields(q, []string{"policyId", "policyVersion"}, []string{"profile"}) || !validText(q["policyId"], 80) || !validText(q["policyVersion"], 32) || q["profile"] != nil && str(q, "profile") != "facts-v2" || v["capabilityId"] == nil {
			return invalid()
		}
	}
	budget, hasBudget := v["budget"]
	if str(v, "collaboration") == "basic-bounty" {
		if !hasBudget || v["capabilityId"] == nil || !hasQualification {
			return invalid()
		}
	} else if hasBudget {
		return invalid()
	}
	if hasBudget {
		b, ok := budget.(map[string]any)
		if !ok || !trimmed(b, "unit", 24) {
			return invalid()
		}
		switch str(b, "mode") {
		case "fixed":
			if !exactFields(b, []string{"mode", "amount", "unit"}, nil) || !decimal.MatchString(str(b, "amount")) {
				return invalid()
			}
		case "range":
			if !exactFields(b, []string{"mode", "minimum", "maximum", "unit"}, nil) || !decimal.MatchString(str(b, "minimum")) || !decimal.MatchString(str(b, "maximum")) {
				return invalid()
			}
			low, _ := new(big.Rat).SetString(str(b, "minimum"))
			high, _ := new(big.Rat).SetString(str(b, "maximum"))
			if low.Cmp(high) > 0 {
				return invalid()
			}
		case "quote":
			if !exactFields(b, []string{"mode", "unit"}, nil) {
				return invalid()
			}
		default:
			return invalid()
		}
	}
	materials := arr(v["materials"])
	if _, ok := v["materials"]; ok && (len(materials) < 1 || len(materials) > 8) {
		return invalid()
	}
	seen := map[string]bool{}
	references := []string{}
	for _, field := range textFields(v) {
		references = append(references, materialIDs(field)...)
	}
	for _, x := range materials {
		d, ok := x.(map[string]any)
		id := str(d, "materialId")
		if !ok || !validDescriptor(d) || seen[id] || !contains(references, id) {
			return invalid()
		}
		seen[id] = true
	}
	for _, id := range references {
		if !seen[id] {
			return invalid()
		}
	}
	return v, nil
}
func (s *Service) CaseLiveWithin(ctx context.Context, tx pgx.Tx, a Actor, id string) error {
	if s.OwnedCaseLive != nil {
		return s.OwnedCaseLive(ctx, tx, a.Actor, id)
	}
	parent, e := row(ctx, tx, "SELECT to_jsonb(c) FROM cases c WHERE id=$1 AND subject_id=$2 FOR SHARE", id, a.SubjectID)
	if e != nil {
		return e
	}
	if parent == nil || str(parent, "state") == "withdrawn" {
		return fail("assistance_case_unavailable", 403)
	}
	events, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM case_events e WHERE case_id=$1 ORDER BY version LIMIT 1001", id)
	if e != nil {
		return e
	}
	if len(events) > 1000 {
		return fail("case_event_limit", 413)
	}
	for _, event := range events {
		if _, e = s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(event, "consent_id"), SubjectID: str(event, "subject_id"), Action: "case.teaser.publish", ObjectID: str(event, "id"), Recipient: s.Endpoint, PayloadJSON: str(event, "payload_text")}); e != nil {
			return e
		}
	}
	return nil
}
func taskReplay(ctx context.Context, tx pgx.Tx, a Actor, taskID, eventID, consentID, payload string) (Object, error) {
	prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", eventID)
	if e != nil || prior == nil {
		return nil, e
	}
	if str(prior, "task_id") != taskID || str(prior, "subject_id") != a.SubjectID || str(prior, "consent_id") != consentID || str(prior, "payload_hash") != identity.Digest([]byte(payload)) {
		return nil, fail("task_event_conflict")
	}
	out := Object{"taskId": taskID, "eventId": eventID, "version": prior["version"]}
	if prior["participation_id"] != nil {
		out["participationId"] = prior["participation_id"]
		out["participationVersion"] = prior["participation_version"]
	}
	return out, nil
}
func (s *Service) CreateTask(ctx context.Context, a Actor, submission TaskSubmission) (any, error) {
	request, e := parseTask(submission.PayloadJSON)
	if e != nil {
		return nil, e
	}
	material := len(arr(request["materials"])) > 0
	if material {
		if submission.SignedIntent == nil || !validText(*submission.SignedIntent, 16384) || len([]byte(submission.PayloadJSON)) > 24000 || len(submission.MaterialBodies) < 1 || len(submission.MaterialBodies) > 8 {
			return nil, fail("invalid_task_material_request", 400)
		}
		if len(jsonBytes(submission)) > 100000 {
			return nil, fail("request_too_large", 413)
		}
	} else if submission.SignedIntent != nil || submission.MaterialBodies != nil {
		return nil, fail("invalid_task_payload", 400)
	} else if !validID(submission.ConsentID) {
		return nil, fail("invalid_task_payload", 400)
	}
	return s.run(ctx, a, "assistance", true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "task-v2:"+str(request, "taskId")); e != nil {
			return nil, e
		}
		consentID := submission.ConsentID
		if material {
			prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", request["operationId"])
			if e != nil {
				return nil, e
			}
			if prior != nil {
				consentID = str(prior, "consent_id")
			}
		}
		replay, e := taskReplay(ctx, tx, a, str(request, "taskId"), str(request, "operationId"), consentID, submission.PayloadJSON)
		if e != nil || replay != nil {
			return replay, e
		}
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM task_requests WHERE id=$1 UNION SELECT 1 FROM assistance_requests WHERE id=$1)", request["taskId"]).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fail("task_conflict")
		}
		if material {
			capture, e := s.Devices.CaptureConsentWithin(ctx, tx, a.Actor, *submission.SignedIntent, deviceauth.ConsentOptions{TaskMaterial: true, HTTPRequestID: a.HTTPRequestID})
			if e != nil {
				return nil, e
			}
			consentID = capture.ConsentID
		}
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: consentID, SubjectID: a.SubjectID, Action: "assistance.publish", ObjectID: str(request, "operationId"), Recipient: s.Endpoint, PayloadJSON: submission.PayloadJSON})
		if e != nil {
			return nil, e
		}
		if grant.Visibility != str(request, "visibility") {
			return nil, fail("task_visibility_mismatch", 403)
		}
		if request["caseId"] != nil {
			if e = s.CaseLiveWithin(ctx, tx, a, str(request, "caseId")); e != nil {
				return nil, e
			}
		}
		if refs := arr(obj(request, "workContext")["attemptRefs"]); len(refs) > 0 {
			if request["caseId"] == nil || s.ValidateTaskContext == nil {
				return nil, fail("task_fact_validation_required")
			}
			if e = s.ValidateTaskContext(ctx, tx, a, str(request, "caseId"), refs); e != nil {
				return nil, e
			}
		}
		if request["parentTaskId"] != nil {
			parent, e := s.RequireTaskWithin(ctx, tx, &a.Actor, str(request, "parentTaskId"), false)
			if e != nil {
				return nil, e
			}
			if str(parent, "requesterId") != a.SubjectID {
				return nil, fail("task_parent_not_authorized", 403)
			}
		}
		if q := obj(request, "qualification"); q != nil {
			if s.ValidateQualification == nil {
				return nil, fail("qualification_unavailable", 503)
			}
			if e = s.ValidateQualification(ctx, tx, q, str(request, "capabilityId"), str(request, "collaboration")); e != nil {
				return nil, e
			}
		}
		materialRows := []MaterialRow{}
		if material {
			materialRows, e = s.ValidateWithin(ctx, tx, a, request, submission.MaterialBodies, grant)
			if e != nil {
				return nil, e
			}
		}
		if num(request["enrollmentExpiresAt"]) <= s.now() {
			return nil, fail("task_enrollment_expired")
		}
		if request["parentTaskId"] != nil && request["parentTaskId"] == request["taskId"] {
			return nil, fail("task_parent_cycle")
		}
		state := Object{"schemaVersion": 2, "requesterId": a.SubjectID, "request": request, "version": 1, "scopeVersion": 1, "state": "open", "suggestions": Object{"state": "not-requested", "items": []any{}, "eventId": nil}, "invitations": []any{}, "applications": []any{}, "participationIds": []any{}, "selected": nil, "enrollment": Object{"state": "open"}, "events": []any{}, "createdAt": s.now(), "lastEventAt": s.now(), "paymentExecuted": false, "contextAccessGranted": false, "roomMembershipGranted": false}
		var quota any
		if str(request, "visibility") == "Public" {
			if s.Writes == nil {
				return nil, fail("public_write_verification_unavailable", 503)
			}
			quota, e = s.Writes.ConsumeWithin(ctx, tx, publicwrites.Actor{Device: &a.Actor, Scope: "assistance"}, publicwrites.Operation{Kind: "task", OperationID: str(request, "operationId"), PayloadHash: identity.Digest([]byte(submission.PayloadJSON)), TaskID: str(request, "taskId")})
			if e != nil {
				return nil, e
			}
		}
		if _, e = tx.Exec(ctx, "INSERT INTO task_requests(id,case_id,requester_id,root_event_id,version,snapshot) VALUES($1,$2,$3,$4,1,$5::jsonb)", request["taskId"], request["caseId"], a.SubjectID, request["operationId"], jsonBytes(state)); e != nil {
			return nil, e
		}
		if material {
			if e = s.InsertWithin(ctx, tx, a, request, consentID, materialRows); e != nil {
				return nil, e
			}
		}
		receipt, e := s.recordTaskEvent(ctx, tx, a, auth, state, str(request, "operationId"), "task-created", consentID, submission.PayloadJSON, nil)
		if e != nil {
			return nil, e
		}
		receipt["caseId"] = request["caseId"]
		receipt["requestPublished"] = true
		receipt["contactSuggestionsState"] = "not-requested"
		receipt["paymentExecuted"] = false
		receipt["quota"] = quota
		return receipt, nil
	})
}
func (s *Service) recordTaskEvent(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, state Object, eventID, kind, consentID, payload string, participation Object) (Object, error) {
	request := obj(state, "request")
	var participationID, participationVersion any
	if participation != nil {
		participationID = participation["participationId"]
		participationVersion = participation["version"]
	}
	if _, e := tx.Exec(ctx, `INSERT INTO task_events(id,task_id,participation_id,subject_id,version,participation_version,kind,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, eventID, request["taskId"], participationID, a.SubjectID, num(state["version"]), participationVersion, kind, consentID, payload, identity.Digest([]byte(payload))); e != nil {
		return nil, e
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,'task.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'assistance',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=(SELECT consent_id FROM task_events WHERE id=$2::text::uuid AND subject_id=$1) AND c.subject_id=$1 AND b.subject_id=$1`, a.SubjectID, eventID, a.HTTPRequestID, jsonBytes(auth.CredentialScopes), a.BindingID)
	if e != nil {
		return nil, e
	}
	if tag.RowsAffected() != 1 {
		return nil, fail("task_audit_context_unavailable", 503)
	}
	out := Object{"taskId": request["taskId"], "eventId": eventID, "version": state["version"]}
	if participation != nil {
		out["participationId"] = participationID
		out["participationVersion"] = participationVersion
		out["state"] = participation["state"]
	} else {
		out["state"] = state["state"]
	}
	return out, nil
}
