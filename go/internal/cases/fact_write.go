package cases

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
	"time"
)

type SubmitOptions struct {
	AllowTaskRoot bool
	OwnerID       string
	Participation Object
}

func factReceipt(event Object, version int64) Object {
	ref := object(event["supersedes"])
	if ref == nil {
		ref = object(event["attemptRef"])
	}
	id := fallback(ref["id"], event["eventId"])
	return Object{"caseId": event["caseId"], "eventId": event["eventId"], "version": version, "caseVersion": version, "objectRef": Object{"id": id, "version": number(ref, "version") + 1}, "claimAuthority": "participant-reported", "verification": "not-provided", "acceptance": "not-provided", "resolution": "separate"}
}
func (s *Service) SubmitV2(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	_, payload, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	event, e := parseFact(payload)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, event["kind"] == "case-withdrawn", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		if id := text(event, "taskId"); id != "" {
			if s.TaskWrite == nil {
				return nil, fault.New("task_service_unavailable", 503)
			}
			task, e := s.TaskWrite(ctx, tx, a, id)
			if e != nil {
				return nil, e
			}
			if task["caseId"] != event["caseId"] {
				return nil, fault.New("task_case_link_required", 409)
			}
		}
		return s.SubmitV2Within(ctx, tx, a, raw, requestID, auth, SubmitOptions{})
	})
}
func (s *Service) SubmitV2Within(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, raw []byte, requestID string, auth deviceauth.ControlAuthorization, opts SubmitOptions) (Object, error) {
	consent, payload, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	event, e := parseFact(payload)
	if e != nil {
		return nil, e
	}
	cid, id, kind := text(event, "caseId"), text(event, "eventId"), text(event, "kind")
	if event["actorId"] != a.SubjectID {
		return nil, fault.New("actor_mismatch", 403)
	}
	if kind == "case-created" {
		if id != cid {
			return nil, fault.New("case_root_id_mismatch", 422)
		}
		if text(event, "participationId") != "" && !(opts.AllowTaskRoot && opts.Participation != nil) {
			return nil, fault.New("requester_required", 403)
		}
		if text(event, "taskId") != "" && !opts.AllowTaskRoot {
			return nil, fault.New("task_case_link_required", 409)
		}
		owner := a.SubjectID
		if opts.OwnerID != "" {
			owner = opts.OwnerID
		}
		if _, e = tx.Exec(ctx, `INSERT INTO cases(id,subject_id,local_ref,source_ref,version,state) VALUES($1,$2,$3,$4,1,'open') ON CONFLICT DO NOTHING`, cid, owner, event["localRef"], object(event["source"])["reference"]); e != nil {
			return nil, e
		}
	}
	parent, e := queryOne(ctx, tx, `SELECT id::text,subject_id,version,state FROM cases WHERE id=$1 FOR UPDATE`, cid)
	if e != nil {
		return nil, e
	}
	if parent == nil {
		return nil, fault.New("case_conflict_or_not_found", 409)
	}
	owner := parent["subject_id"] == a.SubjectID
	var participation Object
	if kind == "case-created" && opts.AllowTaskRoot {
		participation = opts.Participation
	}
	if !owner || text(event, "participationId") != "" {
		if s.TaskRead == nil || s.Participation == nil || text(event, "taskId") == "" || text(event, "participationId") == "" {
			return nil, fault.New("participation_required", 403)
		}
		if participation == nil {
			task, e := s.TaskRead(ctx, tx, a, text(event, "taskId"))
			if e != nil {
				return nil, e
			}
			if task["caseId"] != cid {
				return nil, fault.New("task_case_link_required", 409)
			}
			participation, e = s.Participation(ctx, tx, a, text(event, "taskId"), text(event, "participationId"))
			if e != nil {
				return nil, e
			}
		}
		if participation["subjectId"] != a.SubjectID {
			return nil, fault.New("participation_required", 403)
		}
	}
	intent, e := s.grant(ctx, tx, Object{"id": id, "subject_id": a.SubjectID, "consent_id": consent, "payload_text": payload})
	if e != nil {
		return nil, e
	}
	if intent.Visibility == "Proof-only" {
		return nil, fault.New("disclosure_mismatch", 403)
	}
	existing, e := queryOne(ctx, tx, `SELECT id::text,subject_id,case_id::text,payload_hash,consent_id::text,version FROM case_events WHERE id=$1`, id)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest([]byte(payload))
	if existing != nil {
		if existing["subject_id"] != a.SubjectID || existing["case_id"] != cid || existing["payload_hash"] != hash || existing["consent_id"] != consent {
			return nil, fault.New("event_conflict", 409)
		}
		return factReceipt(event, number(existing, "version")), nil
	}
	if parent["state"] == "withdrawn" {
		return nil, fault.New("case_withdrawn", 409)
	}
	rows, e := events(ctx, tx, cid)
	if e != nil {
		return nil, e
	}
	facts := ProjectFacts(rows, parent)
	if len(rows) >= 1000 {
		return nil, fault.New("case_event_limit", 413)
	}
	if kind == "case-created" {
		if !(owner || opts.AllowTaskRoot && opts.Participation != nil) || len(rows) != 0 {
			return nil, fault.New("case_conflict_or_not_found", 409)
		}
	} else if number(parent, "version") != number(event, "expectedVersion") {
		return nil, fault.New("version_conflict", 409)
	}
	scope := number(event, "scopeVersion")
	if scope == 0 {
		scope = number(event, "taskScopeVersion")
	}
	if scope == 0 {
		scope = number(facts, "scopeVersion")
	}
	if kind != "case-created" && kind != "case-scope-revised" && scope > number(facts, "scopeVersion") {
		return nil, fault.New("invalid_scope_version", 422)
	}
	if participation != nil {
		if participation["paused"] == true || one(participation["taskState"], "canceled", "closed") {
			return nil, fault.New("participation_paused", 403)
		}
		if !one(participation["state"], "active", "delivered", "accepted", "disputed") {
			return nil, fault.New("participation_required", 403)
		}
		version := number(event, "participationScopeVersion")
		if version == 0 {
			version = 1
		}
		if number(participation, "scopeVersion") != version {
			return nil, fault.New("participation_scope_changed", 409)
		}
	}
	ownRef := func(kind string, ref Object, latest bool) (Object, error) {
		return s.RequireFactWithin(ctx, tx, &a, rows, facts, kind, ref, FactOptions{Own: true, Latest: latest})
	}
	if kind == "attempt-start" && event["configurationRef"] != nil {
		ref := copyObject(object(event["configurationRef"]))
		ref["kind"] = "configuration"
		if _, e = s.RequireSourceWithin(ctx, tx, &a, rows, facts, ref); e != nil {
			return nil, e
		}
	}
	if kind == "attempt-end" || kind == "attempt-correct" {
		attempt, e := ownRef("attempt", object(event["attemptRef"]), true)
		if e != nil {
			return nil, e
		}
		if kind == "attempt-end" && attempt["status"] != "running" || kind == "attempt-correct" && attempt["status"] == "running" {
			return nil, fault.New("attempt_transition_denied", 409)
		}
		if number(attempt, "scopeVersion") != scope {
			return nil, fault.New("invalid_scope_version", 422)
		}
		if end, start := text(event, "endedAt"), text(attempt, "startedAt"); end != "" && start != "" {
			ended, e1 := time.Parse(time.RFC3339Nano, end)
			started, e2 := time.Parse(time.RFC3339Nano, start)
			if e1 == nil && e2 == nil && ended.Before(started) {
				return nil, fault.New("invalid_attempt_time", 422)
			}
		}
	}
	if kind == "intervention" {
		if event["supersedes"] != nil {
			if _, e = ownRef("intervention", object(event["supersedes"]), true); e != nil {
				return nil, e
			}
		}
		for _, id := range list(event["affectsAttemptIds"]) {
			attempt := LatestFact(facts, "attempt", id.(string))
			if attempt == nil {
				return nil, fault.New("invalid_case_reference", 422)
			}
			if _, e = s.RequireFactWithin(ctx, tx, &a, rows, facts, "attempt", attempt, FactOptions{}); e != nil {
				return nil, e
			}
		}
		for _, ref := range list(event["sourceRefs"]) {
			if _, e = s.RequireSourceWithin(ctx, tx, &a, rows, facts, object(ref)); e != nil {
				return nil, e
			}
		}
	}
	if kind == "intervention-response" {
		if _, e = s.RequireFactWithin(ctx, tx, &a, rows, facts, "intervention", object(event["interventionRef"]), FactOptions{Latest: true}); e != nil {
			return nil, e
		}
	}
	if kind == "result-recorded" {
		originRef := object(event["origin"])
		origin, e := ownRef(text(originRef, "kind"), originRef, false)
		if e != nil {
			return nil, e
		}
		if number(origin, "scopeVersion") != number(event, "scopeVersion") || origin["taskId"] != event["taskId"] {
			return nil, fault.New("invalid_result_origin", 422)
		}
		if origin["participationId"] != event["participationId"] {
			return nil, fault.New("origin_not_authorized", 403)
		}
		var pv any = event["participationScopeVersion"]
		if pv == nil && text(event, "participationId") != "" {
			pv = int64(1)
		}
		if number(Object{"v": origin["participationScopeVersion"]}, "v") != number(Object{"v": pv}, "v") {
			return nil, fault.New("participation_scope_changed", 409)
		}
		if event["supersedes"] != nil {
			if _, e = ownRef("result", object(event["supersedes"]), true); e != nil {
				return nil, e
			}
		}
		for _, ref := range list(event["deliverableRefs"]) {
			if _, e = s.RequireSourceWithin(ctx, tx, &a, rows, facts, object(ref)); e != nil {
				return nil, e
			}
		}
	}
	if kind == "resolution-recorded" {
		if !owner {
			return nil, fault.New("resolution_authority_required", 403)
		}
		if number(event, "taskScopeVersion") != number(facts, "scopeVersion") {
			return nil, fault.New("invalid_scope_version", 422)
		}
		var previous any
		all := list(facts["resolutions"])
		if len(all) > 0 {
			previous = object(all[len(all)-1])["id"]
		}
		if previous != event["supersedesResolutionId"] {
			return nil, fault.New("resolution_version_conflict", 409)
		}
		for _, ref := range list(event["resultRefs"]) {
			result, e := s.RequireFactWithin(ctx, tx, &a, rows, facts, "result", object(ref), FactOptions{Latest: true})
			if e != nil {
				return nil, e
			}
			if number(result, "scopeVersion") != number(event, "taskScopeVersion") {
				return nil, fault.New("invalid_scope_version", 422)
			}
		}
		for _, ref := range list(event["verificationRefs"]) {
			if s.VerificationReference == nil {
				return nil, fault.New("verification_access_unavailable", 503)
			}
			if _, e = s.VerificationReference(ctx, tx, &a, object(ref), cid, number(event, "taskScopeVersion")); e != nil {
				return nil, e
			}
		}
	}
	if kind == "case-scope-revised" {
		if !owner {
			return nil, fault.New("requester_required", 403)
		}
		if number(event, "taskScopeVersion") != number(facts, "scopeVersion")+1 {
			return nil, fault.New("invalid_scope_version", 422)
		}
		if text(event, "taskId") != "" {
			if s.TaskRead == nil {
				return nil, fault.New("task_service_unavailable", 503)
			}
			task, e := s.TaskRead(ctx, tx, a, text(event, "taskId"))
			if e != nil {
				return nil, e
			}
			if number(object(task["snapshot"]), "scopeVersion") != number(event, "taskScopeVersion") {
				return nil, fault.New("task_scope_not_confirmed", 409)
			}
		}
	}
	if kind == "case-withdrawn" && !owner {
		return nil, fault.New("requester_required", 403)
	}
	version := int64(1)
	if kind != "case-created" {
		version = number(parent, "version") + 1
	}
	if _, e = tx.Exec(ctx, `INSERT INTO case_events(id,case_id,subject_id,kind,version,consent_id,payload,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, id, cid, a.SubjectID, kind, version, consent, string(encode(event)), payload, hash); e != nil {
		return nil, e
	}
	state := parent["state"]
	if kind == "case-withdrawn" {
		state = "withdrawn"
	}
	if _, e = tx.Exec(ctx, `UPDATE cases SET version=$2,state=$3 WHERE id=$1`, cid, version, state); e != nil {
		return nil, e
	}
	if e = s.audit(ctx, tx, a, auth, kind, cid, id, requestID); e != nil {
		return nil, e
	}
	return factReceipt(event, version), nil
}
func (s *Service) RespondBatch(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	input, e := parseLoose(raw)
	if e != nil {
		return nil, e
	}
	requests, ok := input["requests"].([]any)
	if !shape(input, []string{"requests"}, nil) || !ok || len(requests) == 0 || len(requests) > 32 {
		return nil, fault.New("invalid_response_batch", 422)
	}
	results := []any{}
	all := true
	for _, request := range requests {
		raw := encode(request)
		_, payload, err := envelope(raw)
		if err == nil {
			event, pe := parseFact(payload)
			err = pe
			if err == nil && event["kind"] != "intervention-response" {
				err = fault.New("invalid_response_batch", 422)
			}
		}
		var receipt Object
		if err == nil {
			receipt, err = s.SubmitV2(ctx, a, raw, requestID)
		}
		if err != nil {
			var se *fault.Error
			if !errors.As(err, &se) {
				return nil, err
			}
			results = append(results, Object{"status": "rejected", "code": se.Code})
			all = false
		} else {
			results = append(results, Object{"status": "accepted", "receipt": receipt})
		}
	}
	return Object{"results": results, "allAccepted": all}, nil
}
