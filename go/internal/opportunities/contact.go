package opportunities

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/jackc/pgx/v5"
)

// RequireOpportunityWithin rechecks the exact selected source for the signed
// Contact consumer. A previous discovery result is not continuing willingness.
func (s *Service) RequireOpportunityWithin(ctx context.Context, tx pgx.Tx, initiator string, input Object) error {
	current, e := s.ContextForContactWithin(ctx, tx, initiator, Object{"context": input["context"], "purposes": []string{str(input, "purpose")}})
	if e != nil {
		return e
	}
	source, wish := obj(current, "source"), obj(current, "wish")
	if !truth(wish, "enabled") {
		return fail("contact_willingness_unavailable", 403)
	}
	ref, recipient := obj(input, "opportunityRef"), str(input, "recipientId")
	if str(ref, "subjectId") != recipient {
		return fail("contact_willingness_unavailable", 403)
	}
	blocked, e := s.NotificationReader().IsBlockedWithin(ctx, tx, initiator, recipient)
	if e != nil {
		return e
	}
	if blocked {
		return fail("contact_willingness_unavailable", 403)
	}
	if str(ref, "sourceKind") == "recruitment" {
		if s.RecruitmentOpportunity == nil {
			return fail("discovery_recruitment_source_unavailable", 503)
		}
		available, e := s.RecruitmentOpportunity(ctx, tx, initiator, ref, current)
		if e != nil {
			return e
		}
		if available {
			return nil
		}
		return fail("contact_willingness_unavailable", 403)
	}
	if s.Profiles == nil {
		return fail("discovery_profile_unavailable", 503)
	}
	profile, e := s.Profiles.ReadForContactWithin(ctx, tx, initiator, recipient)
	if e != nil {
		return e
	}
	settings, e := s.PreferencesWithin(ctx, tx, recipient)
	if e != nil {
		return e
	}
	if settings == nil {
		settings = projects.DefaultDiscoveryPreferences()
	}
	candidateWish := EffectiveWish(settings, s.now())
	if str(ref, "sourceKind") == "project" {
		if s.Projects == nil {
			return fail("discovery_project_source_unavailable", 503)
		}
		project, e := s.Projects.ReadForContactWithin(ctx, tx, initiator, str(ref, "projectId"))
		if e != nil {
			if fault.Status(e) == 403 || fault.Status(e) == 404 {
				return fail("contact_willingness_unavailable", 403)
			}
			return e
		}
		if str(project, "ownerId") != recipient || str(project, "state") != "active" || truth(obj(project, "operationsVisibility"), "hidden") || !truth(obj(project, "document"), "discoverable") || obj(project, "source")["documentEventId"] != ref["documentEventId"] || obj(project, "source")["policyEventId"] != ref["policyEventId"] {
			return fail("contact_willingness_unavailable", 403)
		}
		candidateWish, e = s.Projects.EffectiveWishWithin(ctx, tx, recipient, str(ref, "projectId"), false, nil)
		if e != nil {
			return e
		}
		if Match(source, obj(project, "document"), wish, candidateWish) != nil {
			return nil
		}
		return fail("contact_willingness_unavailable", 403)
	}
	if !truth(candidateWish, "enabled") || obj(profile, "selfDeclaredSource")["id"] != ref["statementId"] {
		return fail("contact_willingness_unavailable", 403)
	}
	if s.Projects != nil {
		imported, e := s.Projects.ImportedWithin(ctx, tx, recipient, str(ref, "projectId"))
		if e != nil {
			return e
		}
		if imported {
			return fail("contact_willingness_unavailable", 403)
		}
	}
	values := objectItems(obj(profile, "selfDeclared")["projects"])
	for _, project := range values {
		if project["id"] == ref["projectId"] && truth(project, "discoverable") && Match(source, project, wish, candidateWish) != nil {
			return nil
		}
	}
	return fail("contact_willingness_unavailable", 403)
}
