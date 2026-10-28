package moderation

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// CaseContextWireWithin matches History's Case-context slot, not a report-ID
// lookup. The enclosing History/Proof reader already established its caller.
func (s *Service) CaseContextWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, caseID string) (json.RawMessage, error) {
	context, e := s.CaseContextWithin(ctx, tx, a, caseID)
	if e != nil {
		return nil, e
	}
	wire := ordered(context, "version", "authority", "automaticallyVerified", "items", "coverage")
	items := []any{}
	for _, item := range objectsOf(context["items"]) {
		entry := ordered(item, "reportId", "version", "state", "paused", "report", "events", "revalidation", "source")
		entry.Set("report", reportWire(obj(item, "report")))
		events := []any{}
		for _, event := range objectsOf(item["events"]) {
			r, e := row(ctx, tx, "SELECT to_jsonb(e) FROM (SELECT payload_text FROM moderation_events WHERE id=$1 AND report_id=$2)e", event["id"], item["reportId"])
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
			v := ordered(event, "actorId", "version")
			for _, key := range payload.Keys() {
				v.Set(key, payload.Values()[key])
			}
			if event["kind"] == "verification-response" {
				v.Set("authority", "participant-signed-review")
				v.Set("independenceVerified", false)
				v.Set("capabilityVerified", false)
			}
			events = append(events, v)
		}
		entry.Set("events", events)
		var revalidation, source any
		if status := obj(item, "revalidation"); status != nil {
			revalidation = ordered(status, "evidenceId", "generation", "state", "observation")
		}
		if v := obj(item, "source"); v != nil {
			source = ordered(v, "reportedVersion", "currentVersion", "targetEventId")
		}
		entry.Set("revalidation", revalidation)
		entry.Set("source", source)
		items = append(items, entry)
	}
	wire.Set("items", items)
	return protocol.EncodeJS(wire)
}
