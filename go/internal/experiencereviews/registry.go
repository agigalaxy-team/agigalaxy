package experiencereviews

import (
	"context"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

func ReviewerHash(input Object) (string, error) {
	p, e := ParseReviewer(input)
	if e != nil {
		return "", e
	}
	for _, key := range []string{"capabilityIds", "kinds"} {
		seen := map[string]bool{}
		values := []string{}
		for _, v := range array(p[key]) {
			if !seen[text(v)] {
				seen[text(v)] = true
				values = append(values, text(v))
			}
		}
		sort.Strings(values)
		p[key] = values
	}
	raw, e := identity.Canonical(p)
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
func RegistryManifest(reviewers []Object) (Object, error) {
	rows := []any{}
	for _, reviewer := range reviewers {
		hash, e := ReviewerHash(reviewer)
		if e != nil {
			return nil, e
		}
		rows = append(rows, Object{"subjectId": reviewer["subjectId"], "definitionHash": hash})
	}
	c := collate.New(language.English)
	sort.SliceStable(rows, func(i, j int) bool {
		return c.CompareString(str(object(rows[i]), "subjectId"), str(object(rows[j]), "subjectId")) < 0
	})
	return Object{"version": 1, "reviewers": rows}, nil
}
func CurrentRegistryWithin(ctx context.Context, tx pgx.Tx, endpoint string) (Object, error) {
	current, e := row(ctx, tx, "SELECT to_jsonb(r) FROM runtime_config_events r WHERE endpoint=$1 AND component='api' ORDER BY sequence DESC LIMIT 1", endpoint)
	if e != nil {
		return nil, e
	}
	registry := object(object(object(current["payload"])["snapshot"])["experienceReviewerRegistry"])
	if registry == nil || !integer(registry["version"], 1) || number(registry["version"]) != 1 {
		return nil, fail("experience_reviewer_registry_unavailable", 503)
	}
	if _, ok := registry["reviewers"].([]any); !ok {
		return nil, fail("experience_reviewer_registry_unavailable", 503)
	}
	out := Object{"configurationEventId": current["id"]}
	for k, v := range registry {
		out[k] = v
	}
	return out, nil
}
func (s *Service) UseRegistry(ctx context.Context) error {
	if _, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return CurrentRegistryWithin(ctx, tx, s.Endpoint) }); e != nil {
		return e
	}
	s.registryEnabled = true
	return nil
}
func (s *Service) reviewerWithin(ctx context.Context, tx pgx.Tx, subject, capability, kind string) (Object, error) {
	var selected Object
	for _, r := range s.reviewers {
		caps, kinds := false, false
		for _, v := range array(r["capabilityIds"]) {
			if v == capability {
				caps = true
			}
		}
		for _, v := range array(r["kinds"]) {
			if v == kind {
				kinds = true
			}
		}
		if r["subjectId"] == subject && caps && kinds && number(r["notBefore"]) <= s.now() && number(r["notAfter"]) > s.now() {
			selected = r
			break
		}
	}
	if selected == nil {
		return nil, fail("experience_reviewer_unavailable", 403)
	}
	if s.registryEnabled {
		registry, e := CurrentRegistryWithin(ctx, tx, s.Endpoint)
		if e != nil {
			return nil, e
		}
		hash, e := ReviewerHash(selected)
		if e != nil {
			return nil, e
		}
		matched := false
		for _, v := range array(registry["reviewers"]) {
			r := object(v)
			if r["subjectId"] == subject && r["definitionHash"] == hash {
				matched = true
				break
			}
		}
		if !matched {
			return nil, fail("experience_reviewer_unavailable", 403)
		}
	}
	return selected, nil
}
