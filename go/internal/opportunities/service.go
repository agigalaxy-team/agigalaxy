// Package opportunities owns the original participant opportunity context,
// wishes, functional matcher and temporary DiscoveryV2 cursor. Professional
// public-content search/recommendation remains a separate domain.
package opportunities

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"sync"
	"time"
)

type Object = map[string]any
type RecruitmentReader interface {
	OpportunitiesWithin(context.Context, pgx.Tx, *deviceauth.Actor, string, Object) ([]Object, error)
}
type HistoryReader interface {
	QueryWithin(context.Context, pgx.Tx, *deviceauth.Actor, []byte) (map[string]any, error)
}
type Service struct {
	Pool                   *pgxpool.Pool
	Devices                *deviceauth.Service
	History                HistoryReader
	Recruitment            RecruitmentReader
	ScanWindowLimit        int
	Endpoint               string
	Profiles               *profiles.Service
	Notifications          *notifications.Service
	Projects               *projects.Service
	Now                    func() time.Time
	RecruitmentOpportunity func(context.Context, pgx.Tx, string, Object, Object) (bool, error)
	cursorOnce             sync.Once
	cursorKey              []byte
	cursorError            error
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func str(o Object, k string) string      { v, _ := o[k].(string); return v }
func obj(o Object, k string) Object      { v, _ := o[k].(map[string]any); return v }
func truth(o Object, k string) bool      { v, _ := o[k].(bool); return v }
func fail(code string, status int) error { return fault.New(code, status) }
func stringsOf(v any) []string {
	if a, ok := v.([]string); ok {
		return a
	}
	a, _ := v.([]any)
	out := []string{}
	for _, value := range a {
		if s, ok := value.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
func has(a []string, b string) bool {
	for _, v := range a {
		if v == b {
			return true
		}
	}
	return false
}
func (s *Service) NotificationReader() *notifications.Service {
	if s.Notifications != nil {
		return s.Notifications
	}
	return &notifications.Service{Pool: s.Pool, Devices: s.Devices, Endpoint: s.Endpoint, Now: s.Now}
}
func (s *Service) PreferencesWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	return s.NotificationReader().DiscoveryPreferencesWithin(ctx, tx, id)
}
func (s *Service) UseProjects(source *projects.Service) {
	s.Projects = source
	if source.DiscoveryPreferences == nil {
		source.DiscoveryPreferences = s.PreferencesWithin
	}
}
func EffectiveWish(p Object, now int64) Object {
	t := obj(p, "temporary")
	if t != nil {
		n := number(t["until"])
		if n <= now {
			t = nil
		}
	}
	purposes, functions := p["purposes"], p["functions"]
	var until any
	if t != nil {
		until = t["until"]
		if t["purposes"] != nil {
			purposes = t["purposes"]
		}
		if t["functions"] != nil {
			functions = t["functions"]
		}
	}
	return Object{"enabled": truth(p, "enabled") && (t == nil || str(t, "contact") != "paused"), "purposes": stringsOf(purposes), "functions": projects.NormalizeFunctions(stringsOf(functions)), "temporaryUntil": until}
}
func (s *Service) ContextWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, options Object) (Object, error) {
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	return s.context(ctx, tx, viewer, options, func() (Object, error) {
		if s.Profiles == nil {
			return nil, fail("discovery_profile_unavailable", 503)
		}
		return s.Profiles.ReadWithin(ctx, tx, a, viewer)
	})
}

// ContextForContactWithin is used after the exact signed send/response grants
// prove the original initiator. It never fabricates a credential actor.
func (s *Service) ContextForContactWithin(ctx context.Context, tx pgx.Tx, viewer string, options Object) (Object, error) {
	return s.context(ctx, tx, viewer, options, func() (Object, error) {
		if s.Profiles == nil {
			return nil, fail("discovery_profile_unavailable", 503)
		}
		return s.Profiles.ReadForContactWithin(ctx, tx, viewer, viewer)
	})
}
func (s *Service) context(ctx context.Context, tx pgx.Tx, viewer string, options Object, profileRead func() (Object, error)) (Object, error) {
	context := obj(options, "context")
	source := context
	var sourceRef Object
	if str(context, "kind") == "project" {
		if viewer == "" {
			return nil, fail("access_denied", 401)
		}
		profile, e := profileRead()
		if e != nil {
			return nil, e
		}
		source = nil
		values := objectItems(obj(profile, "selfDeclared")["projects"])
		for _, p := range values {
			if p["id"] == context["projectId"] {
				source = p
				break
			}
		}
		if s.Projects != nil {
			exists, e := s.Projects.ExistsWithin(ctx, tx, str(context, "projectId"))
			if e != nil {
				return nil, e
			}
			if exists {
				p, e := s.Projects.ReadForContactWithin(ctx, tx, viewer, str(context, "projectId"))
				if e != nil {
					return nil, e
				}
				source = Object{}
				for k, v := range obj(p, "document") {
					source[k] = v
				}
				source["id"] = p["projectId"]
				sourceRef = Object{"sourceKind": "project", "subjectId": p["ownerId"], "projectId": p["projectId"], "documentEventId": obj(p, "source")["documentEventId"], "policyEventId": obj(p, "source")["policyEventId"]}
			}
		}
		if source == nil {
			return nil, fail("discovery_project_not_found", 404)
		}
		if sourceRef == nil {
			sourceRef = Object{"subjectId": viewer, "projectId": source["id"], "statementId": obj(profile, "selfDeclaredSource")["id"]}
		}
	}
	var settings Object
	var e error
	if viewer != "" {
		settings, e = s.PreferencesWithin(ctx, tx, viewer)
		if e != nil {
			return nil, e
		}
	}
	enabled := true
	var until any
	if settings != nil {
		current := EffectiveWish(settings, s.now())
		enabled = truth(current, "enabled")
		until = current["temporaryUntil"]
	}
	wish := Object{"enabled": enabled, "purposes": stringsOf(options["purposes"]), "functions": []string{}, "temporaryUntil": until}
	if s.Projects != nil && str(sourceRef, "sourceKind") == "project" {
		wish, e = s.Projects.EffectiveWishWithin(ctx, tx, viewer, str(source, "id"), true, stringsOf(options["purposes"]))
		if e != nil {
			return nil, e
		}
	}
	return Object{"source": source, "sourceRef": sourceRef, "wish": wish}, nil
}
func ContactFunctions(shared []string, left, right Object) []string {
	source, candidate := projects.NormalizeFunctions(stringsOf(left["functions"])), projects.NormalizeFunctions(stringsOf(right["functions"]))
	out := []string{}
	for _, v := range shared {
		if (len(source) == 0 || has(source, v)) && (len(candidate) == 0 || has(candidate, v)) {
			out = append(out, v)
		}
	}
	return out
}
func Match(source, candidate, leftWish, rightWish Object) Object {
	if !truth(leftWish, "enabled") || !truth(rightWish, "enabled") {
		return nil
	}
	purposes := []string{}
	for _, p := range stringsOf(leftWish["purposes"]) {
		if has(stringsOf(rightWish["purposes"]), p) {
			purposes = append(purposes, p)
		}
	}
	left, right := projects.NormalizeFunctions(stringsOf(source["functions"])), projects.NormalizeFunctions(stringsOf(candidate["functions"]))
	shared, onlyLeft, onlyRight := []string{}, []string{}, []string{}
	union := append([]string{}, left...)
	for _, v := range left {
		if has(right, v) {
			shared = append(shared, v)
		} else {
			onlyLeft = append(onlyLeft, v)
		}
	}
	for _, v := range right {
		if !has(left, v) {
			onlyRight = append(onlyRight, v)
			union = append(union, v)
		}
	}
	if len(purposes) == 0 || len(shared) == 0 || len(ContactFunctions(shared, leftWish, rightWish)) == 0 {
		return nil
	}
	technologies := func(a, b any) []string {
		left, right := projects.NormalizeFunctions(stringsOf(a)), projects.NormalizeFunctions(stringsOf(b))
		out := []string{}
		for _, v := range left {
			if !has(right, v) {
				out = append(out, v)
			}
		}
		return out
	}
	return Object{"method": "functional-tags-v1", "score": float64(len(shared)) / float64(len(union)), "sharedFunctions": shared, "purposes": purposes, "differences": Object{"sourceOnlyFunctions": onlyLeft, "candidateOnlyFunctions": onlyRight, "sourceOnlyTechnologies": technologies(source["technologies"], candidate["technologies"]), "candidateOnlyTechnologies": technologies(candidate["technologies"], source["technologies"])}}
}
