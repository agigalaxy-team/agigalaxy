package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

type LegacyLoaded struct {
	Row    Object
	Events []Object
	Grants map[string]deviceauth.ConsentIntent
	Paused bool
}

// LegacySourceVisible applies the same current grant projection as the owner
// service after LegacyLoadWithin has checked the real source and grant records.
func (s *Service) LegacySourceVisible(grant deviceauth.ConsentIntent, viewer string) bool {
	return s.visible(grant, viewer)
}

func (s *Service) legacyGrant(ctx context.Context, tx pgx.Tx, subject, consentID, eventID, payload string) (deviceauth.ConsentIntent, error) {
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: consentID, SubjectID: subject, Action: "assistance.publish", ObjectID: eventID, Recipient: s.Endpoint, PayloadJSON: payload})
}
func (s *Service) LegacyLoadWithin(ctx context.Context, tx pgx.Tx, id string, readOnly bool) (LegacyLoaded, error) {
	result := LegacyLoaded{Grants: map[string]deviceauth.ConsentIntent{}}
	lock := "UPDATE"
	if readOnly {
		lock = "SHARE"
	}
	current, e := row(ctx, tx, "SELECT to_jsonb(a) FROM assistance_requests a WHERE id=$1 FOR "+lock, id)
	if e != nil {
		return result, e
	}
	if current == nil {
		task, e := row(ctx, tx, "SELECT jsonb_build_object('id',id) FROM task_requests WHERE id=$1 FOR SHARE", id)
		if e != nil {
			return result, e
		}
		if task != nil {
			return result, fail("unsupported_semantics")
		}
		return result, fail("not_found", 404)
	}
	if s.CaseOwnerSource == nil {
		return result, fail("assistance_case_source_unavailable", 503)
	}
	if e = s.CaseOwnerSource(ctx, tx, str(current, "case_id"), str(current, "requester_id")); e != nil {
		return result, e
	}
	events, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM assistance_events e WHERE assistance_id=$1 ORDER BY version LIMIT 1002", id)
	if e != nil {
		return result, e
	}
	if len(events) > 1001 {
		return result, fail("assistance_event_limit", 413)
	}
	for _, event := range events {
		grant, e := s.legacyGrant(ctx, tx, str(event, "subject_id"), str(event, "consent_id"), str(event, "id"), str(event, "payload_text"))
		if e != nil {
			return result, e
		}
		result.Grants[str(event, "id")] = grant
	}
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM moderation_reports WHERE (assistance_id=$1 OR case_id=$2)AND paused=true)", id, current["case_id"]).Scan(&result.Paused); e != nil {
		return result, e
	}
	result.Row, result.Events = current, events
	return result, nil
}
func (s *Service) LegacyCaseReviewEventsWithin(ctx context.Context, tx pgx.Tx, caseID, viewer string) ([]Object, error) {
	events, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM case_events e WHERE case_id=$1 AND kind='revision' ORDER BY version", caseID)
	if e != nil {
		return nil, e
	}
	for _, event := range events {
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(event, "consent_id"), SubjectID: str(event, "subject_id"), Action: "case.teaser.publish", ObjectID: str(event, "id"), Recipient: s.Endpoint, PayloadJSON: str(event, "payload_text")})
		if e != nil {
			return nil, e
		}
		if !s.visible(grant, viewer) {
			return nil, fail("assistance_case_review_unavailable", 404)
		}
	}
	return events, nil
}
func (s *Service) legacyCaseReview(ctx context.Context, tx pgx.Tx, caseID, viewer string) (Object, error) {
	events, e := s.LegacyCaseReviewEventsWithin(ctx, tx, caseID, viewer)
	if e != nil {
		return nil, e
	}
	version := int64(0)
	count := 0
	for _, event := range events {
		version = num(event["version"])
		if obj(event, "payload")["review"] == nil {
			count++
		}
	}
	return Object{"caseId": caseID, "reviewVersion": version, "correctionCount": count, "scope": "case-correction-and-review-events-only", "authority": "case-owner-reported"}, nil
}

// LegacyReviewProjection is shared by original contribution and eligibility
// consumers after their current Case revision grants have been checked.
func LegacyReviewProjection(revisions []Object, state Object) Object {
	threads := map[string]Object{}
	corrections := []Object{}
	for _, row := range revisions {
		payload := obj(row, "payload")
		review := obj(payload, "review")
		if review == nil {
			corrections = append(corrections, row)
		} else {
			threads[str(review, "threadId")] = review
		}
	}
	pendingCorrection, pendingDispute := false, false
	for _, review := range threads {
		if !contains([]string{"resolved", "rejected"}, str(review, "state")) {
			if review["type"] == "correction" {
				pendingCorrection = true
			}
			if review["type"] == "dispute" {
				pendingDispute = true
			}
		}
	}
	correctionPending := pendingCorrection
	for _, row := range corrections {
		if num(row["version"]) > num(obj(state, "delivery")["caseReviewVersion"]) {
			correctionPending = true
		}
	}
	var acceptance Object
	for _, value := range arr(state["events"]) {
		record := value.(map[string]any)
		event := obj(record, "event")
		if event["kind"] == "accept" && event["deliveryId"] == obj(state, "delivery")["id"] {
			acceptance = record
		}
	}
	return Object{"textCorrections": corrections, "corrected": len(corrections) > 0 || pendingCorrection, "correctionPending": correctionPending, "disputed": pendingDispute || contains([]string{"disputed", "awaiting-resolution-confirmation"}, str(state, "state")), "acceptance": acceptance, "accepted": state["state"] == "accepted" && acceptance != nil}
}
func (s *Service) LegacyReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	loaded, e := s.LegacyLoadWithin(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	if !s.visible(loaded.Grants[id], viewer) {
		return nil, fail("not_found", 404)
	}
	state := obj(loaded.Row, "snapshot")
	features := Object{"deliveryCaseReview": 1, "resumeWorkResolution": 1, "publicRequesterFeedback": 1}
	var deliverySource Object
	if viewer == str(loaded.Row, "requester_id") || viewer == str(obj(state, "selected"), "providerId") {
		deliverySource, e = s.legacyCaseReview(ctx, tx, str(loaded.Row, "case_id"), viewer)
		if e != nil {
			if _, ok := e.(*fault.Error); !ok {
				return nil, e
			}
			deliverySource = nil
		}
	}
	if viewer == str(loaded.Row, "requester_id") {
		out := clone(state)
		out["paused"], out["deliverySource"], out["eventFeatures"], out["view"] = loaded.Paused, deliverySource, features, "requester"
		return out, nil
	}
	offers := []Object{}
	for _, value := range arr(state["offers"]) {
		offer := value.(map[string]any)
		if offer["providerId"] == viewer {
			offers = append(offers, offer)
		}
	}
	if str(obj(state, "selected"), "providerId") != viewer {
		return Object{"request": state["request"], "paused": loaded.Paused, "eventFeatures": features, "requesterId": state["requesterId"], "version": state["version"], "state": state["state"], "view": "applicant", "offers": offers, "contextAccessGranted": false, "paymentExecuted": false, "capabilityVerified": false}, nil
	}
	out := clone(state)
	out["paused"], out["deliverySource"], out["eventFeatures"], out["view"], out["offers"], out["shortlist"] = loaded.Paused, deliverySource, features, "selected-provider", offers, []any{}
	invitations := []Object{}
	for _, value := range arr(state["invitations"]) {
		invitation := value.(map[string]any)
		if invitation["participantId"] == viewer {
			invitations = append(invitations, invitation)
		}
	}
	out["invitations"] = invitations
	events := []Object{}
	for _, value := range arr(state["events"]) {
		record := value.(map[string]any)
		event := obj(record, "event")
		if event["kind"] != "shortlist" && s.visible(loaded.Grants[str(event, "id")], viewer) {
			events = append(events, record)
		}
	}
	out["events"] = events
	return out, nil
}
func legacyTaskView(state Object) Object {
	request := obj(state, "request")
	participants := []any{}
	provider := str(obj(state, "selected"), "providerId")
	if provider != "" {
		participants = append(participants, Object{"participationId": "legacy-v1:" + str(request, "id"), "subjectId": provider, "role": "main-responsible", "state": state["state"], "agreedScope": state["agreedScope"], "provenance": "legacy-v1"})
	}
	return Object{"schemaVersion": 1, "taskId": request["id"], "caseId": request["caseId"], "requesterId": state["requesterId"], "request": request, "state": state["state"], "version": state["version"], "selected": state["selected"], "participations": participants, "compatibility": Object{"source": "legacy-v1", "writableApiVersion": 1, "v2Writes": false}, "paymentExecuted": false, "contextAccessGranted": false}
}
