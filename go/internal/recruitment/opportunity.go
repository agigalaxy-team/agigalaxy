package recruitment

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/jackc/pgx/v5"
)

func (s *Service) opportunityWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, viewer string, r, context Object) (Object, error) {
	if r["contact_subject_id"] == viewer || !has(stringsOf(obj(context, "wish")["purposes"]), "recruitment") {
		return nil, nil
	}
	view, e := s.readWithin(ctx, tx, a, viewer, str(r, "id"), true)
	if e != nil {
		if unavailable(e) {
			return nil, nil
		}
		return nil, e
	}
	wish, e := s.Projects.EffectiveWishWithin(ctx, tx, str(r, "contact_subject_id"), str(r, "project_id"), true, []string{"recruitment"})
	if e != nil {
		return nil, e
	}
	match := opportunities.Match(obj(context, "source"), obj(view, "document"), obj(context, "wish"), wish)
	if match == nil {
		return nil, nil
	}
	ref := Object{"sourceKind": "recruitment", "subjectId": r["contact_subject_id"], "projectId": r["project_id"], "recruitmentId": r["id"], "eventId": r["current_event_id"]}
	document := Object{}
	for k, v := range obj(view, "document") {
		document[k] = v
	}
	document["id"], document["kind"] = r["project_id"], "role-requirement"
	return Object{"id": opportunities.OpportunityID(ref), "opportunityRef": ref, "subjectId": r["contact_subject_id"], "projectId": r["project_id"], "recruitmentId": r["id"], "project": document, "recruitment": view, "participant": Object{"subjectId": r["contact_subject_id"], "kind": "unknown", "kindSource": "project-representative; human-or-agent-not-inferred"}, "classification": "declared-role-requirement", "capabilityVerified": false, "match": match, "help": Object{"statement": obj(view, "document")["summary"], "functions": opportunities.ContactFunctions(stringsOf(match["sharedFunctions"]), obj(context, "wish"), wish), "purposes": []string{"recruitment"}, "basis": "explicit-current-role-requirement-and-representative-authority", "commitment": "not-contacted"}, "contactState": "welcome", "willingness": Object{"classification": "explicit-recruitment-publication", "purposes": []string{"recruitment"}, "temporaryUntil": wish["temporaryUntil"], "requiresRecipientAcceptance": true}, "sources": []any{view["originalSource"]}, "experience": Object{"status": "not-loaded", "refs": []any{}, "lookup": "discovery-detail", "absenceMeaning": "no-history-is-not-ineligibility"}, "nextActions": []string{"inspect", "consider-contact"}, "invitationSent": false, "roomJoined": false}, nil
}
func (s *Service) OpportunitiesWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, subject string, context Object) ([]Object, error) {
	viewer := ""
	if a != nil {
		if e := s.Devices.AuthorizeWithin(ctx, tx, *a, "history"); e != nil {
			return nil, e
		}
		viewer = a.SubjectID
	}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(o) FROM recruitment_opportunities o WHERE contact_subject_id=$1 AND state='active' AND expires_at>$2 ORDER BY id LIMIT 200", subject, stamp(s.now()))
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, r := range rr {
		v, e := s.opportunityWithin(ctx, tx, a, viewer, r, context)
		if e != nil {
			return nil, e
		}
		if v != nil {
			out = append(out, v)
		}
	}
	return out, nil
}

// RequireContactOpportunityWithin is only called after both Contact signatures
// establish the initiator. It cannot provide credential-dependent task links.
func (s *Service) RequireContactOpportunityWithin(ctx context.Context, tx pgx.Tx, initiator string, ref, context Object) (bool, error) {
	r, e := s.source(ctx, tx, str(ref, "recruitmentId"), false)
	if unavailable(e) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	v, e := s.opportunityWithin(ctx, tx, nil, initiator, r, context)
	if e != nil {
		return false, e
	}
	return v != nil && opportunities.SameRef(obj(v, "opportunityRef"), ref), nil
}
