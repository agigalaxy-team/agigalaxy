package capsules

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// VisibleUpdateWithin preserves the original interest requirement: a prior
// currently authorized reference/application, never a mere read.
func (s *Service) VisibleUpdateWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, eventID string) (Object, error) {
	event, e := one(ctx, tx, `SELECT * FROM capsule_events WHERE id=$1`, eventID)
	if e != nil || event == nil {
		return nil, e
	}
	g, e := s.grant(ctx, tx, event, "capsule.publish")
	if e != nil {
		return nil, e
	}
	if !s.visible(g, &a) {
		return nil, nil
	}
	uses, e := query(ctx, tx, `SELECT id,subject_id,consent_id,payload_text FROM capsule_uses WHERE capsule_id=$1 AND subject_id=$2 AND observed_revision<$3 UNION ALL SELECT id,subject_id,consent_id,payload_text FROM capsule_uses_v2 WHERE capsule_id=$1 AND subject_id=$2 AND observed_revision<$3`, event["capsule_id"], a.SubjectID, event["revision"])
	if e != nil {
		return nil, e
	}
	authorized := false
	for _, use := range uses {
		g, e := s.grant(ctx, tx, use, "capsule.use")
		if e != nil {
			if absent(e) {
				continue
			}
			return nil, e
		}
		if s.visible(g, &a) {
			authorized = true
			break
		}
	}
	if !authorized {
		return nil, nil
	}
	current, e := s.versionWithin(ctx, tx, &a, text(event, "capsule_id"), text(event, "version_id"), true, false)
	if e != nil {
		return nil, e
	}
	wire, e := parseStored(event)
	if e != nil {
		return nil, e
	}
	payload := wire.Values()
	unavailable := current.status == "source-unavailable"
	title := any(current.payload["title"])
	var summary any = payload["summary"]
	if summary == nil {
		summary = "New Capsule version"
	}
	if unavailable {
		title = "Capsule 来源或版本状态已变化"
		summary = nil
	}
	return Object{"title": title, "capsuleId": event["capsule_id"], "versionId": event["version_id"], "actorId": event["subject_id"], "eventKind": payload["kind"], "sourceStatus": current.status, "deprecated": current.deprecated, "securityIssue": current.security, "summary": summary, "object": Object{"type": "capsule", "id": event["capsule_id"], "versionId": event["version_id"]}, "sourceBodyIncluded": false}, nil
}
