package moderation

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
	"sort"
)

func (s *Service) verifierSource(ctx context.Context, tx pgx.Tx, r Object, viewer string, target Object) error {
	if target == nil {
		target = obj(r, "reportData")
	}
	if target == nil {
		return fail("not_found", 404)
	}
	if r["case_id"] != nil {
		if _, e := s.caseSource(ctx, tx, viewer, str(r, "case_id"), false); e != nil {
			return e
		}
		if target["evidenceId"] != nil {
			_, e := s.evidenceTarget(ctx, tx, viewer, str(r, "case_id"), str(target, "targetEventId"), str(target, "evidenceId"))
			return e
		}
		return nil
	}
	if s.Assistance == nil {
		return fail("moderation_assistance_unavailable", 503)
	}
	source, e := s.Assistance.LegacyLoadWithin(ctx, tx, str(r, "assistance_id"), false)
	if e != nil {
		return e
	}
	if !s.Assistance.LegacySourceVisible(source.Grants[str(source.Row, "id")], viewer) {
		return fail("not_found", 404)
	}
	for _, record := range objectsOf(obj(source.Row, "snapshot")["events"]) {
		if !s.Assistance.LegacySourceVisible(source.Grants[str(obj(record, "event"), "id")], viewer) {
			return fail("not_found", 404)
		}
	}
	return nil
}
func (s *Service) liveInvitation(ctx context.Context, tx pgx.Tx, r Object, viewer, id string) (Object, error) {
	var invitation Object
	for _, v := range objectsOf(r["recorded"]) {
		if v["id"] == id {
			invitation = v
			break
		}
	}
	if invitation == nil {
		return nil, fail("verifier_invitation_required", 403)
	}
	g, e := s.grant(ctx, tx, str(invitation, "subject_id"), str(invitation, "consent_id"), str(invitation, "id"), str(invitation, "payload_text"))
	if e != nil {
		return nil, e
	}
	if !s.visible(g, viewer) {
		return nil, fail("verifier_invitation_unavailable", 403)
	}
	return ParsePayload([]byte(str(invitation, "payload_text")), false)
}
func (s *Service) checkRecipients(g deviceauth.ConsentIntent, actor string, recipients []string) error {
	expected := []string{}
	for _, id := range unique(recipients) {
		if id != actor {
			expected = append(expected, id)
		}
	}
	sort.Strings(expected)
	actual := append([]string{}, g.Viewers...)
	sort.Strings(actual)
	if len(expected) == 0 || g.Visibility != "Private" || len(expected) != len(actual) {
		return fail("moderation_recipient_mismatch", 403)
	}
	for i := range expected {
		if expected[i] != actual[i] {
			return fail("moderation_recipient_mismatch", 403)
		}
	}
	return nil
}
