package cases

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

type FactOptions struct {
	Own, Latest     bool
	Visited         map[string]bool
	ReadEventWithin func(Object) error
}

func (s *Service) RequireEventVisibleWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, row Object) (deviceauth.ConsentIntent, error) {
	if row == nil || text(row, "payload_text") == "" {
		return deviceauth.ConsentIntent{}, fault.New("case_event_unavailable", 404)
	}
	intent, e := s.grant(ctx, tx, row)
	if e != nil {
		return intent, e
	}
	viewer := s.sourceViewer(a)
	allowed := false
	if intent.IssuedAt <= s.now() && intent.ExpiresAt > s.now() {
		switch {
		case viewer != "" && viewer == intent.SubjectID:
			allowed = true
		case intent.CurrentVisibility != nil && intent.CurrentVisibility.DeletionPending:
		case intent.Visibility == "Public":
			allowed = intent.Purpose == "public-profile"
		case intent.Visibility == "Private" || intent.Visibility == "Hub-scoped" && s.Endpoint == intent.Recipient:
			if viewer != "" {
				for _, v := range intent.Viewers {
					allowed = allowed || v == viewer
				}
			}
		}
	}
	if !allowed {
		return intent, fault.New("origin_not_authorized", 403)
	}
	return intent, nil
}
func (s *Service) RequireFactWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, rows []Object, facts Object, kind string, ref Object, opts FactOptions) (Object, error) {
	found := FactAt(facts, kind, ref)
	if found == nil {
		return nil, fault.New("invalid_result_origin", 422)
	}
	if opts.Own && (s.sourceViewer(a) == "" || found["actorId"] != s.sourceViewer(a)) {
		return nil, fault.New("origin_not_authorized", 403)
	}
	if opts.Latest {
		latest := LatestFact(facts, kind, text(ref, "id"))
		if latest == nil || number(latest, "version") != number(ref, "version") {
			return nil, fault.New("fact_version_conflict", 409)
		}
		changes := map[string][]string{"attempt": {"attempt-end", "attempt-correct"}, "intervention": {"intervention"}, "result": {"result-recorded"}}
		for _, row := range rows {
			if one(row["kind"], changes[kind]...) && text(row, "payload_text") == "" && row["subject_id"] == found["actorId"] && number(row, "version") > number(found, "caseVersion") {
				return nil, fault.New("fact_currentness_unavailable", 409)
			}
		}
	}
	if opts.Visited == nil {
		opts.Visited = map[string]bool{}
	}
	key := fmt.Sprintf("%s:%s:%d", kind, text(ref, "id"), number(ref, "version"))
	if opts.Visited[key] {
		return found, nil
	}
	opts.Visited[key] = true
	seen := map[string]bool{}
	for _, id := range list(found["recordEventIds"]) {
		id, _ := id.(string)
		if seen[id] {
			continue
		}
		seen[id] = true
		var row Object
		for _, r := range rows {
			if r["id"] == id {
				row = r
				break
			}
		}
		if row == nil {
			return nil, fault.New("invalid_result_origin", 422)
		}
		if opts.ReadEventWithin != nil {
			if e := opts.ReadEventWithin(row); e != nil {
				return nil, e
			}
		} else if _, e := s.RequireEventVisibleWithin(ctx, tx, a, row); e != nil {
			return nil, e
		}
		p := object(row["payload"])
		refs := append(append([]any{}, list(p["sourceRefs"])...), list(p["deliverableRefs"])...)
		for _, ref := range refs {
			if _, e := s.requireSource(ctx, tx, a, rows, facts, object(ref), opts.Visited, opts.ReadEventWithin); e != nil {
				return nil, e
			}
		}
	}
	return found, nil
}
func (s *Service) RequireSourceWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, rows []Object, facts, ref Object) (Object, error) {
	return s.requireSource(ctx, tx, a, rows, facts, ref, nil, nil)
}
func (s *Service) requireSource(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, rows []Object, facts, ref Object, visited map[string]bool, read func(Object) error) (Object, error) {
	if one(ref["kind"], "attempt", "intervention", "result") {
		return s.RequireFactWithin(ctx, tx, a, rows, facts, text(ref, "kind"), ref, FactOptions{Visited: visited, ReadEventWithin: read})
	}
	if s.grantAuthor != "" {
		if s.GrantAuthorSources == nil {
			return nil, fault.New("source_access_unavailable", 503)
		}
		return s.GrantAuthorSources(ctx, tx, s.grantAuthor, ref, Object{"caseId": facts["caseId"], "visited": visited})
	}
	if s.Sources == nil {
		return nil, fault.New("source_access_unavailable", 503)
	}
	return s.Sources(ctx, tx, a, ref, Object{"caseId": facts["caseId"], "visited": visited})
}
