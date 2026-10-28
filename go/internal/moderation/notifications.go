package moderation

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) NotificationReadWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, candidate Object) (Object, error) {
	return s.NotificationViewWithin(ctx, tx, a, str(candidate, "kind"), str(candidate, "event_id"))
}
func (s *Service) NotificationViewWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, kind, eventID string) (Object, error) {
	if !has([]string{"moderation-report", "moderation-event"}, kind) {
		return nil, nil
	}
	if _, e := s.Devices.CurrentControlWithin(ctx, tx, a, "notifications"); e != nil {
		return nil, e
	}
	initial := kind == "moderation-report"
	q := "SELECT to_jsonb(e) FROM (SELECT id,report_id,subject_id,consent_id,payload_text,created_at FROM moderation_events WHERE id=$1)e"
	if initial {
		q = "SELECT to_jsonb(e) FROM (SELECT id,id report_id,reporter_id subject_id,consent_id,payload_text,created_at FROM moderation_reports WHERE id=$1)e"
	}
	r, e := row(ctx, tx, q, eventID)
	if e != nil || r == nil {
		return nil, e
	}
	if r["subject_id"] == a.SubjectID {
		return nil, nil
	}
	view, e := func() (Object, error) {
		g, e := s.grant(ctx, tx, str(r, "subject_id"), str(r, "consent_id"), str(r, "id"), str(r, "payload_text"))
		if e != nil {
			return nil, e
		}
		if !s.visible(g, a.SubjectID) {
			return nil, nil
		}
		report, e := s.ReadWithin(ctx, tx, Actor{Device: &a}, str(r, "report_id"), nil)
		if e != nil {
			return nil, e
		}
		event := obj(report, "report")
		if !initial {
			event = nil
			for _, v := range objectsOf(report["events"]) {
				if v["id"] == r["id"] {
					event = v
					break
				}
			}
		}
		if event == nil {
			return nil, nil
		}
		eventKind := "report"
		version := any(1)
		if !initial {
			eventKind = str(event, "kind")
			version = event["version"]
		}
		expires := g.ExpiresAt
		if eventKind == "invite-verifier" {
			own := obj(obj(report, "verifierParticipation"), "own")
			if event["verifierId"] != a.SubjectID || own["invitationId"] != eventID || own["status"] != "invited" || !truth(report, "canAcceptVerifier") || !truth(obj(report, "verifierParticipation"), "sourceAvailable") {
				return nil, nil
			}
			if num(own, "expiresAt") < expires {
				expires = num(own, "expiresAt")
			}
		}
		title, category := "举报或复核事项有更新", "incidents"
		if eventKind == "invite-verifier" {
			title, category = "邀请你参与具体复核", "invitations"
		}
		return Object{"title": title, "actorId": r["subject_id"], "category": category, "eventKind": "moderation-" + eventKind, "object": Object{"type": "moderation", "id": r["report_id"], "eventId": r["id"], "version": version}, "serviceReceipt": has([]string{"pause", "resume", "resolve", "appeal", "revalidate"}, eventKind), "sourceExpiresAt": time.Unix(expires, 0).UTC().Format("2006-01-02T15:04:05.000Z")}, nil
	}()
	if e != nil && (fault.Status(e) == 403 || fault.Status(e) == 404 || fault.Status(e) == 410) {
		return nil, nil
	}
	return view, e
}
