package notifications

import (
	"context"
	_ "embed"
	"sort"

	"github.com/jackc/pgx/v5"
)

// These are the original fixed source catalogs, never request-supplied SQL.
//
//go:embed legacy_candidates.sql
var legacyCandidateSQL string

//go:embed inbox_candidates.sql
var inboxCandidateSQL string

//go:embed moderation_candidates.sql
var moderationCandidateSQL string

type queryInput struct {
	After      string
	Limit      int64
	UnreadOnly bool
}
type exactLocator struct{ Kind, ID string }

func parseQuery(input Object, legacy bool) (queryInput, error) {
	q := queryInput{Limit: 10}
	if legacy {
		q.Limit = 8
	}
	code := "invalid_inbox_request"
	if legacy {
		code = "invalid_notification_query"
	}
	if !shape(input, nil, []string{"after", "limit", "unreadOnly"}) {
		return q, fail(code, 400)
	}
	if value, ok := input["after"]; ok {
		q.After = text(value)
		if _, _, e := locator(q.After, legacy); e != nil {
			return q, fail(code, 400)
		}
	}
	if value, ok := input["limit"]; ok {
		if !integer(value, 1, 20) {
			return q, fail(code, 400)
		}
		q.Limit = num(value)
	}
	if value, ok := input["unreadOnly"]; ok {
		v, ok := value.(bool)
		if !ok {
			return q, fail(code, 400)
		}
		q.UnreadOnly = v
	}
	return q, nil
}
func queryCursors(q queryInput, exact *exactLocator) (afterID, afterKind, exactKind, exactID any) {
	if q.After != "" {
		afterKind, afterID, _ = locator(q.After, false)
	}
	if exact != nil {
		exactKind, exactID = exact.Kind, exact.ID
	}
	return
}
func (s *Service) legacyCandidates(ctx context.Context, tx pgx.Tx, subject string, q queryInput, settings Object, exact *exactLocator, archived any) ([]Object, error) {
	afterID, afterKind, exactKind, exactID := queryCursors(q, exact)
	maximum := 200
	if exact != nil {
		maximum = 1
	}
	blocked := false
	if s.EvidenceBlocked != nil {
		blocked = s.EvidenceBlocked()
	}
	return many(ctx, tx, "SELECT to_jsonb(c) FROM ("+legacyCandidateSQL+") c", subject, afterID, afterKind, q.UnreadOnly, settings["invitations"], settings["collaboration"], settings["materials"], stringsOf(settings["mutedAssistanceIds"]), exactKind, exactID, maximum, settings["capsules"], stamp(s.now()), settings["incidents"], blocked, archived)
}
func (s *Service) newCandidates(ctx context.Context, tx pgx.Tx, subject string, q queryInput, exact *exactLocator) ([]Object, error) {
	afterID, afterKind, exactKind, exactID := queryCursors(q, exact)
	return many(ctx, tx, "SELECT to_jsonb(c) FROM ("+inboxCandidateSQL+") c", subject, stamp(s.now()), stamp(s.now()-90*86400), afterID, afterKind, exactKind, exactID, q.UnreadOnly)
}
func (s *Service) moderationCandidates(ctx context.Context, tx pgx.Tx, subject string, q queryInput, exact *exactLocator) ([]Object, error) {
	if exact != nil && exact.Kind != "moderation-report" && exact.Kind != "moderation-event" {
		return []Object{}, nil
	}
	afterID, afterKind, exactKind, exactID := queryCursors(q, exact)
	return many(ctx, tx, "SELECT to_jsonb(c) FROM ("+moderationCandidateSQL+") c", subject, stamp(s.now()), stamp(s.now()-90*86400), afterID, afterKind, exactKind, exactID, q.UnreadOnly)
}

type collected struct {
	Candidates    []Object
	Legacy, Extra Object
	PossiblyMore  bool
}

func (s *Service) collect(ctx context.Context, tx pgx.Tx, a Actor, q queryInput, exact *exactLocator) (collected, error) {
	out := collected{}
	legacy, e := s.PreferencesWithin(ctx, tx, a.SubjectID)
	if e != nil {
		return out, e
	}
	extra, e := s.OptionsWithin(ctx, tx, a.SubjectID)
	if e != nil {
		return out, e
	}
	settings := Object{}
	for k, v := range object(legacy["settings"]) {
		settings[k] = v
	}
	for _, key := range []string{"invitations", "collaboration", "materials", "capsules", "incidents"} {
		settings[key] = true
	}
	settings["mutedAssistanceIds"] = []any{}
	old, e := s.legacyCandidates(ctx, tx, a.SubjectID, q, settings, exact, legacy["archivedBefore"])
	if e != nil {
		return out, e
	}
	current, e := s.newCandidates(ctx, tx, a.SubjectID, q, exact)
	if e != nil {
		return out, e
	}
	moderation, e := s.moderationCandidates(ctx, tx, a.SubjectID, q, exact)
	if e != nil {
		return out, e
	}
	all := append(append(old, current...), moderation...)
	out.PossiblyMore = len(old) == 200 || len(current) == 200 || len(moderation) == 200 || len(all) > 200
	cutoff := s.now()*1000 - 90*86400*1000
	archive := milliseconds(legacy["archivedBefore"])
	candidates := []Object{}
	for _, candidate := range all {
		created := milliseconds(candidate["created_at"])
		if created > cutoff && (legacy["archivedBefore"] == nil || created >= archive) {
			candidates = append(candidates, candidate)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := str(candidates[i], "event_id"), str(candidates[j], "event_id")
		if left == right {
			return str(candidates[i], "kind") < str(candidates[j], "kind")
		}
		return left < right
	})
	if len(candidates) > 200 {
		candidates = candidates[:200]
	}
	out.Candidates, out.Legacy, out.Extra = candidates, legacy, extra
	return out, nil
}
