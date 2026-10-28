package opportunities

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/jackc/pgx/v5"
	"time"
)

func iso(v any) any {
	if v == nil {
		return nil
	}
	t, ok := v.(time.Time)
	if !ok {
		value, _ := v.(string)
		t, _ = time.Parse(time.RFC3339Nano, value)
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func (s *Service) opportunityWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, subject string, context Object) ([]Object, error) {
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	blocked, e := s.NotificationReader().IsBlockedWithin(ctx, tx, viewer, subject)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	if blocked {
		return items, nil
	}
	if s.Profiles == nil {
		return nil, fail("discovery_profile_unavailable", 503)
	}
	profile, e := s.Profiles.ReadWithin(ctx, tx, a, subject)
	if e != nil {
		return nil, e
	}
	saved, e := s.NotificationReader().PreferencesWithin(ctx, tx, subject)
	if e != nil {
		return nil, e
	}
	settings := obj(obj(saved, "settings"), "discovery")
	if settings == nil {
		settings = projects.DefaultDiscoveryPreferences()
	}
	wish := EffectiveWish(settings, s.now())
	if s.Recruitment != nil {
		items, e = s.Recruitment.OpportunitiesWithin(ctx, tx, a, subject, context)
		if e != nil {
			return nil, e
		}
	}
	if !truth(wish, "enabled") {
		return items, nil
	}
	var statement Object
	if obj(profile, "selfDeclaredSource") != nil {
		statement, e = s.Profiles.StatementMetadataWithin(ctx, tx, str(obj(profile, "selfDeclaredSource"), "id"))
		if e != nil {
			return nil, e
		}
	}
	declarations := objectItems(obj(profile, "selfDeclared")["projects"])
	for _, project := range declarations {
		if statement == nil || !truth(project, "discoverable") {
			continue
		}
		if s.Projects != nil {
			imported, e := s.Projects.ImportedWithin(ctx, tx, subject, str(project, "id"))
			if e != nil {
				return nil, e
			}
			if imported {
				continue
			}
		}
		match := Match(obj(context, "source"), project, obj(context, "wish"), wish)
		if match == nil {
			continue
		}
		ref := Object{"subjectId": subject, "projectId": project["id"], "statementId": obj(profile, "selfDeclaredSource")["id"]}
		source := Object{}
		for k, v := range ref {
			source[k] = v
		}
		source["revision"], source["recordedAt"], source["sourceUrl"] = statement["revision"], iso(statement["created_at"]), project["sourceUrl"]
		card := s.card(subject, project, ref, profile, match, obj(context, "wish"), wish, []Object{source})
		card["participant"] = Object{"subjectId": subject, "kind": "unknown", "kindSource": "not-declared-in-current-profile"}
		obj(card, "willingness")["revision"] = saved["revision"]
		items = append(items, card)
	}
	if s.Projects != nil {
		rr, e := s.Projects.DiscoveryCandidatesWithin(ctx, tx, subject)
		if e != nil {
			return nil, e
		}
		for _, record := range rr {
			view, e := s.Projects.ReadWithin(ctx, tx, a, str(record, "id"))
			if e != nil {
				if fault.Status(e) == 403 || fault.Status(e) == 404 {
					continue
				}
				return nil, e
			}
			if truth(obj(view, "operationsVisibility"), "hidden") || !truth(obj(view, "document"), "discoverable") {
				continue
			}
			project := Object{}
			for k, v := range obj(view, "document") {
				project[k] = v
			}
			project["id"] = view["projectId"]
			specific, e := s.Projects.EffectiveWishWithin(ctx, tx, subject, str(project, "id"), false, nil)
			if e != nil {
				return nil, e
			}
			match := Match(obj(context, "source"), project, obj(context, "wish"), specific)
			if match == nil {
				continue
			}
			ref := Object{"sourceKind": "project", "subjectId": subject, "projectId": project["id"], "documentEventId": obj(view, "source")["documentEventId"], "policyEventId": obj(view, "source")["policyEventId"]}
			source := Object{"sourceKind": "project", "projectId": project["id"], "revision": view["revision"]}
			for k, v := range obj(view, "source") {
				source[k] = v
			}
			source["recordedAt"], source["sourceUrl"] = iso(record["created_at"]), project["sourceUrl"]
			card := s.card(subject, project, ref, profile, match, obj(context, "wish"), specific, []Object{source})
			card["participant"] = Object{"subjectId": subject, "kind": project["participantKind"], "kindSource": "self-declared-project-document"}
			items = append(items, card)
		}
	}
	return items, nil
}
func (s *Service) card(subject string, project, ref, profile, match, left, right Object, sources []Object) Object {
	return Object{"id": OpportunityID(ref), "opportunityRef": ref, "subjectId": subject, "projectId": project["id"], "project": project, "displayName": obj(profile, "selfDeclared")["displayName"], "classification": "self-declared", "capabilityVerified": false, "match": match, "help": Object{"statement": project["summary"], "functions": ContactFunctions(stringsOf(match["sharedFunctions"]), left, right), "purposes": match["purposes"], "basis": "current-project-declaration-and-expressed-discovery-willingness", "commitment": "not-contacted"}, "contactState": "welcome", "willingness": Object{"classification": "expressed-preference", "purposes": match["purposes"], "temporaryUntil": right["temporaryUntil"], "requiresRecipientAcceptance": true}, "sources": sources, "experience": Object{"status": "not-loaded", "refs": []any{}, "lookup": "discovery-detail", "absenceMeaning": "not-a-history-or-capability-judgment"}, "nextActions": []string{"inspect", "consider-contact"}, "invitationSent": false, "roomJoined": false}
}
