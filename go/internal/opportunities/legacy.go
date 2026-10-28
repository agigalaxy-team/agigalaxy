package opportunities

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/jackc/pgx/v5"
	"sort"
	"strings"
)

func (s *Service) preferenceView(current Object) Object {
	preferences := obj(obj(current, "settings"), "discovery")
	if preferences == nil {
		preferences = projects.DefaultDiscoveryPreferences()
	}
	return Object{"preferences": preferences, "revision": current["revision"], "effective": EffectiveWish(preferences, s.now())}
}
func (s *Service) Preferences(ctx context.Context, a deviceauth.Actor, requestID *string) (Object, error) {
	current, e := s.NotificationReader().Preferences(ctx, notifications.Actor{Actor: a, HTTPRequestID: requestID})
	if e != nil {
		return nil, e
	}
	return s.preferenceView(current.(map[string]any)), nil
}
func (s *Service) SavePreferences(ctx context.Context, a deviceauth.Actor, input Object, requestID *string) (Object, error) {
	if input == nil || !exact(input, "expectedRevision", "preferences") {
		return nil, fail("invalid_discovery_preferences", 409)
	}
	revision, ok := safeInt(input["expectedRevision"], 0, 9007199254740991)
	if !ok {
		return nil, fail("invalid_discovery_preferences", 409)
	}
	preferences, e := projects.ParseDiscoveryPreferences(obj(input, "preferences"))
	if e != nil {
		return nil, fail("invalid_discovery_preferences", 409)
	}
	reader := s.NotificationReader()
	actor := notifications.Actor{Actor: a, HTTPRequestID: requestID}
	current, e := reader.Preferences(ctx, actor)
	if e != nil {
		return nil, e
	}
	settings := Object{}
	for k, v := range obj(current.(map[string]any), "settings") {
		settings[k] = v
	}
	settings["discovery"] = preferences
	value, e := reader.SavePreferences(ctx, actor, Object{"expectedRevision": revision, "settings": settings})
	if e != nil {
		return nil, e
	}
	return s.preferenceView(value.(map[string]any)), nil
}

// QueryLegacy keeps the existing profile-only first window. ProjectV2 and
// Recruitment candidates belong to V2 and do not silently expand this API.
func (s *Service) QueryLegacy(ctx context.Context, a *deviceauth.Actor, input Object) (Object, error) {
	if input == nil || !exact(input, "projectId", "limit") || !UUID.MatchString(str(input, "projectId")) {
		return nil, fail("invalid_discovery_query", 409)
	}
	limit := int64(8)
	if v, ok := input["limit"]; ok {
		var good bool
		limit, good = safeInt(v, 1, 20)
		if !good {
			return nil, fail("invalid_discovery_query", 409)
		}
	}
	if a == nil {
		return nil, fail("access_denied", 401)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.authorize(ctx, tx, a); e != nil {
			return nil, e
		}
		if s.Profiles == nil {
			return nil, fail("discovery_profile_unavailable", 503)
		}
		own, e := s.Profiles.ReadWithin(ctx, tx, a, a.SubjectID)
		if e != nil {
			return nil, e
		}
		var source Object
		for _, project := range objectItems(obj(own, "selfDeclared")["projects"]) {
			if project["id"] == input["projectId"] {
				source = project
				break
			}
		}
		if source == nil {
			return nil, fail("discovery_project_not_found", 404)
		}
		preferences, e := s.NotificationReader().PreferencesWithin(ctx, tx, a.SubjectID)
		if e != nil {
			return nil, e
		}
		wish := obj(s.preferenceView(preferences), "effective")
		result := Object{"items": []Object{}, "enabled": wish["enabled"], "method": "functional-tags-v1", "computedAt": s.now(), "windowLimited": false, "resultLimited": false, "capabilityVerified": false}
		if !truth(wish, "enabled") {
			return result, nil
		}
		rr, e := tx.Query(ctx, `SELECT subject_id FROM (SELECT DISTINCT ON(subject_id) subject_id,id,created_at FROM profile_statements WHERE subject_id<>$1 ORDER BY subject_id,revision DESC)latest ORDER BY created_at DESC,id LIMIT 201`, a.SubjectID)
		if e != nil {
			return nil, e
		}
		candidates := []string{}
		for rr.Next() {
			var id string
			if e = rr.Scan(&id); e != nil {
				rr.Close()
				return nil, e
			}
			candidates = append(candidates, id)
		}
		e = rr.Err()
		rr.Close()
		if e != nil {
			return nil, e
		}
		result["windowLimited"] = len(candidates) > 200
		if len(candidates) > 200 {
			candidates = candidates[:200]
		}
		items := []Object{}
		for _, subject := range candidates {
			profile, e := s.Profiles.ReadWithin(ctx, tx, a, subject)
			if e != nil {
				return nil, e
			}
			projects := []Object{}
			for _, p := range objectItems(obj(profile, "selfDeclared")["projects"]) {
				if truth(p, "discoverable") {
					projects = append(projects, p)
				}
			}
			if len(projects) == 0 {
				continue
			}
			saved, e := s.NotificationReader().PreferencesWithin(ctx, tx, subject)
			if e != nil {
				return nil, e
			}
			other := obj(s.preferenceView(saved), "effective")
			for _, project := range projects {
				match := Match(source, project, wish, other)
				if match == nil {
					continue
				}
				id := identity.Digest([]byte(strings.Join([]string{a.SubjectID, str(source, "id"), str(obj(own, "selfDeclaredSource"), "id"), subject, str(project, "id"), str(obj(profile, "selfDeclaredSource"), "id")}, ":")))
				items = append(items, Object{"id": id, "project": project, "subjectId": subject, "displayName": obj(profile, "selfDeclared")["displayName"], "match": match, "classification": "self-declared", "capabilityVerified": false, "sources": []Object{{"subjectId": a.SubjectID, "projectId": source["id"], "statementId": obj(own, "selfDeclaredSource")["id"], "sourceUrl": source["sourceUrl"]}, {"subjectId": subject, "projectId": project["id"], "statementId": obj(profile, "selfDeclaredSource")["id"], "sourceUrl": project["sourceUrl"]}}})
			}
		}
		score := func(x Object) float64 { n, _ := obj(x, "match")["score"].(float64); return n }
		sort.SliceStable(items, func(i, j int) bool {
			if score(items[i]) != score(items[j]) {
				return score(items[i]) > score(items[j])
			}
			return str(items[i], "id") < str(items[j], "id")
		})
		result["resultLimited"] = len(items) > int(limit)
		if len(items) > int(limit) {
			items = items[:limit]
		}
		result["items"] = items
		return result, nil
	})
}
