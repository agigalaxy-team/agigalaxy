package moderation

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type EvidenceStatusReader interface {
	ModerationVerificationWithin(context.Context, pgx.Tx, string) (map[string]any, error)
}

func (s *Service) Config(ctx context.Context, a Actor) (Object, error) {
	return s.run(ctx, a, false, false, func(_ pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return Object{"moderatorIds": append([]string{}, s.ModeratorIDs...), "canModerate": s.isModerator(a.Device.SubjectID), "reportTargets": []string{"assistance", "case"}, "evidenceRevalidation": s.Evidence != nil, "verifierParticipation": 1, "guaranteesResolution": false}, nil
	})
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a Actor, id string, preloaded Object) (Object, error) {
	r := preloaded
	var e error
	if r == nil {
		r, e = s.load(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
	}
	if r == nil || a.Device == nil || !s.allowed(a.Device.SubjectID, r) {
		return nil, fail("not_found", 404)
	}
	viewer := a.Device.SubjectID
	visible := func(subject, consent, event, payload string) (bool, error) {
		g, e := s.grant(ctx, tx, subject, consent, event, payload)
		if e != nil {
			if serviceError(e) {
				return false, nil
			}
			return false, e
		}
		return s.visible(g, viewer), nil
	}
	canRead, e := visible(str(r, "reporter_id"), str(r, "consent_id"), id, str(r, "payload_text"))
	if e != nil {
		return nil, e
	}
	events := []Object{}
	recorded := objectsOf(r["recorded"])
	own := verifier(r, viewer)
	independent := s.independent(viewer, r)
	ps := parties(r)
	for _, event := range recorded {
		allowed, e := visible(str(event, "subject_id"), str(event, "consent_id"), str(event, "id"), str(event, "payload_text"))
		if e != nil {
			return nil, e
		}
		if allowed {
			var payload Object
			if protocol.Decode([]byte(str(event, "payload_text")), &payload) != nil {
				return nil, fail("stored_integrity_mismatch", 500)
			}
			view := Object{"actorId": event["subject_id"], "version": event["version"]}
			for k, v := range payload {
				view[k] = v
			}
			if payload["kind"] == "verification-response" {
				view["authority"], view["independenceVerified"], view["capabilityVerified"] = "participant-signed-review", false, false
			}
			events = append(events, view)
		}
	}
	var invitation Object
	if own != nil {
		for _, event := range events {
			if event["id"] == own["invitationId"] {
				invitation = event
				break
			}
		}
	}
	sourceAvailable := false
	if own != nil && invitation != nil {
		e = s.verifierSource(ctx, tx, r, viewer, obj(invitation, "target"))
		if e != nil && !serviceError(e) {
			return nil, e
		}
		sourceAvailable = e == nil
	}
	var report Object
	if canRead {
		report = obj(r, "reportData")
	}
	var revalidation, source any
	if r["case_id"] != nil && report["evidenceId"] != nil && s.Evidence != nil {
		_, e := s.evidenceTarget(ctx, tx, viewer, str(r, "case_id"), str(report, "targetEventId"), str(report, "evidenceId"))
		if e == nil {
			status, ok := s.Evidence.(EvidenceStatusReader)
			if !ok {
				e = fail("evidence_revalidation_unavailable", 409)
			} else {
				revalidation, e = status.ModerationVerificationWithin(ctx, tx, str(report, "evidenceId"))
			}
		}
		if e != nil && !serviceError(e) {
			return nil, e
		}
	}
	if r["case_id"] != nil && (canRead || invitation != nil) {
		current, e := s.caseSource(ctx, tx, viewer, str(r, "case_id"), false)
		if e != nil {
			if !serviceError(e) {
				return nil, e
			}
		} else {
			reported := report
			if reported == nil {
				reported = obj(invitation, "target")
			}
			if reported != nil {
				var target any
				for _, event := range objectsOf(current["rows"]) {
					if event["id"] == reported["targetEventId"] {
						target = event["payload"]
						break
					}
				}
				source = Object{"caseId": r["case_id"], "reportedVersion": reported["caseVersion"], "currentVersion": obj(current, "parent")["version"], "targetEventId": reported["targetEventId"], "targetEvent": target}
			}
		}
	}
	out := Object{"reportId": id, "version": r["version"], "state": r["state"], "paused": r["paused"]}
	if r["case_id"] != nil {
		out["caseId"], out["source"], out["revalidation"], out["canRevalidate"] = r["case_id"], source, revalidation, source != nil && revalidation != nil && independent
		out["authority"], out["automaticallyVerified"], out["pauseEffect"] = "moderation-process", false, "hold-linked-collaboration-and-its-derived-eligibility; source-events-and-signed-CI-facts-unchanged"
	} else {
		out["assistanceId"] = r["assistance_id"]
	}
	out["report"], out["events"] = report, events
	if s.isModerator(viewer) || own != nil {
		others := []string{}
		for _, id := range ps {
			if id != r["reporter_id"] {
				others = append(others, id)
			}
		}
		out["reporterId"], out["participantIds"] = r["reporter_id"], others
	}
	var ownView any
	if own != nil {
		v := Object{}
		for k, x := range own {
			v[k] = x
		}
		v["scope"], v["target"] = invitation["scope"], invitation["target"]
		ownView = v
	}
	participation := Object{"version": 1, "own": ownView, "sourceAvailable": sourceAvailable, "authority": "participant-signed-review", "independenceVerified": false, "capabilityVerified": false}
	if s.isModerator(viewer) {
		participation["assignments"] = r["verifiers"]
	}
	out["verifierParticipation"] = participation
	out["canInviteVerifier"], out["canAcceptVerifier"] = independent && canRead, invitation != nil && own["status"] == "invited" && num(own, "expiresAt") > s.now()
	out["canDeclineVerifier"], out["canWithdrawVerifier"], out["canSubmitVerification"] = own["status"] == "invited", own["status"] == "accepted", invitation != nil && own["status"] == "accepted" && sourceAvailable
	out["canAppeal"], out["canSupplement"], out["canModerate"] = has(ps, viewer), has(ps, viewer) || independent, independent
	correctable := []string{}
	if viewer == r["reporter_id"] {
		correctable = append(correctable, id)
	}
	for _, event := range recorded {
		if event["subject_id"] == viewer {
			correctable = append(correctable, str(event, "id"))
		}
	}
	out["canCorrectEventIds"] = correctable
	return out, nil
}
func (s *Service) Get(ctx context.Context, a Actor, id string) (Object, error) {
	if !opportunities.UUID.MatchString(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadWithin(ctx, tx, a, id, nil)
	})
}
func (s *Service) Receipt(ctx context.Context, a Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "reportId", "eventId", "payloadHash") || !opportunities.UUID.MatchString(str(q, "reportId")) || !opportunities.UUID.MatchString(str(q, "eventId")) || !digestText(str(q, "payloadHash")) {
		return nil, fail("invalid_moderation_receipt", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		base := Object{"reportId": q["reportId"], "eventId": q["eventId"], "payloadHash": q["payloadHash"], "authority": "accepted-operation-only", "currentAccessGranted": false, "contentReturned": false, "independenceVerified": false, "capabilityVerified": false}
		rr, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT id,id AS report_id,payload_hash,1 AS version FROM moderation_reports WHERE id=$1 AND reporter_id=$2 UNION ALL SELECT id,report_id,payload_hash,version FROM moderation_events WHERE id=$1 AND subject_id=$2)r`, q["eventId"], a.Device.SubjectID)
		if e != nil {
			return nil, e
		}
		base["state"] = "absent"
		if len(rr) > 0 {
			base["state"] = "conflict"
			for _, r := range rr {
				if r["report_id"] == q["reportId"] && r["payload_hash"] == q["payloadHash"] {
					base["state"] = "acknowledged"
					base["receipt"] = Object{"reportId": q["reportId"], "eventId": q["eventId"], "version": r["version"]}
					break
				}
			}
		}
		return base, nil
	})
}
