package moderation

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func ordered(x Object, keys ...string) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for _, k := range keys {
		if v, ok := x[k]; ok {
			o.Set(k, v)
		}
	}
	return o
}
func reportWire(x Object) any {
	if x == nil {
		return nil
	}
	return ordered(x, "id", "category", "summary", "assistanceId", "caseId", "caseVersion", "targetEventId", "evidenceId")
}
func verifierWire(x Object) *protocol.OrderedObject {
	return ordered(x, "subjectId", "invitationId", "inviterId", "expiresAt", "status", "participated", "invitationAvailable", "responseEventId")
}

// readConsumerWithin uses the caller's actual existing purpose. It does not
// turn History/export authority into a new moderation credential.
func (s *Service) readConsumerWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id, scope string) (Object, error) {
	if a == nil {
		return nil, fail("not_found", 404)
	}
	if s.Devices == nil {
		return nil, fail("moderation_unavailable", 503)
	}
	if e := s.Devices.AuthorizeWithin(ctx, tx, *a, scope); e != nil {
		return nil, e
	}
	return s.ReadWithin(ctx, tx, Actor{Device: a}, id, nil)
}
func (s *Service) ReadHistoryWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	return s.readConsumerWithin(ctx, tx, a, id, "history")
}
func (s *Service) ReadLifecycleWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	return s.readConsumerWithin(ctx, tx, a, id, "data-export")
}
func (s *Service) viewWire(ctx context.Context, tx pgx.Tx, view Object) (*protocol.OrderedObject, error) {
	out := ordered(view, "reportId", "caseId", "assistanceId", "version", "state", "paused", "source", "revalidation", "canRevalidate", "authority", "automaticallyVerified", "pauseEffect", "report", "events", "reporterId", "participantIds", "verifierParticipation", "canInviteVerifier", "canAcceptVerifier", "canDeclineVerifier", "canWithdrawVerifier", "canSubmitVerification", "canAppeal", "canSupplement", "canCorrectEventIds", "canModerate")
	out.Set("report", reportWire(obj(view, "report")))
	if _, ok := view["source"]; ok {
		var source any
		if v := obj(view, "source"); v != nil {
			source = ordered(v, "caseId", "reportedVersion", "currentVersion", "targetEventId", "targetEvent")
		}
		out.Set("source", source)
	}
	if _, ok := view["revalidation"]; ok {
		var status any
		if v := obj(view, "revalidation"); v != nil {
			status = ordered(v, "evidenceId", "generation", "state", "observation")
		}
		out.Set("revalidation", status)
	}
	events := []any{}
	rawEvents := map[string]*protocol.OrderedObject{}
	for _, event := range objectsOf(view["events"]) {
		r, e := row(ctx, tx, "SELECT to_jsonb(e) FROM (SELECT payload_text FROM moderation_events WHERE id=$1 AND report_id=$2)e", event["id"], view["reportId"])
		if e != nil {
			return nil, e
		}
		raw, e := protocol.DecodeOrdered([]byte(str(r, "payload_text")))
		if e != nil {
			return nil, e
		}
		payload, ok := raw.(*protocol.OrderedObject)
		if !ok {
			return nil, fail("stored_integrity_mismatch", 500)
		}
		rawEvents[str(event, "id")] = payload
		wire := ordered(event, "actorId", "version")
		for _, k := range payload.Keys() {
			wire.Set(k, payload.Values()[k])
		}
		if event["kind"] == "verification-response" {
			wire.Set("authority", event["authority"])
			wire.Set("independenceVerified", false)
			wire.Set("capabilityVerified", false)
		}
		events = append(events, wire)
	}
	out.Set("events", events)
	p := obj(view, "verifierParticipation")
	participation := ordered(p, "version", "own", "assignments", "sourceAvailable", "authority", "independenceVerified", "capabilityVerified")
	var own any
	if v := obj(p, "own"); v != nil {
		member := verifierWire(v)
		member.Set("scope", v["scope"])
		target := v["target"]
		if invitation := rawEvents[str(v, "invitationId")]; invitation != nil {
			target = invitation.Values()["target"]
		}
		member.Set("target", target)
		own = member
	}
	participation.Set("own", own)
	if _, ok := p["assignments"]; ok {
		assignments := []any{}
		for _, v := range objectsOf(p["assignments"]) {
			assignments = append(assignments, verifierWire(v))
		}
		participation.Set("assignments", assignments)
	}
	out.Set("verifierParticipation", participation)
	return out, nil
}

// ReadHistoryWireWithin preserves the existing original JSON.stringify source
// projection hash while sharing the same current Case/consent/verifier reads.
func (s *Service) ReadHistoryWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (json.RawMessage, error) {
	view, e := s.ReadHistoryWithin(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	wire, e := s.viewWire(ctx, tx, view)
	if e != nil {
		return nil, e
	}
	return protocol.EncodeJS(wire)
}
