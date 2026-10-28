package projects

import (
	"context"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"sort"
	"strings"
	"unicode/utf16"
)

func wishStrings(v any) []string {
	if values, ok := v.([]string); ok {
		return values
	}
	values, _ := v.([]any)
	out := []string{}
	for _, v := range values {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// NormalizeFunction is the original shared NFKC/whitespace/lowercase matcher.
func NormalizeFunction(s string) string {
	s = norm.NFKC.String(s)
	s = strings.Join(strings.FieldsFunc(s, func(r rune) bool { return trim(string(r)) == "" }), " ")
	return cases.Lower(language.Und).String(s)
}
func wishTags(v any) []string {
	return NormalizeFunctions(wishStrings(v))
}
func NormalizeFunctions(values []string) []string {
	out := []string{}
	for _, s := range values {
		s = NormalizeFunction(s)
		if !contains(out, s) {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := utf16.Encode([]rune(out[i])), utf16.Encode([]rune(out[j]))
		for k := 0; k < len(a) && k < len(b); k++ {
			if a[k] != b[k] {
				return a[k] < b[k]
			}
		}
		return len(a) < len(b)
	})
	return out
}
func parseWish(input Object) (Object, error) {
	if input == nil || !strict(input, "enabled", "purposes", "functions", "temporary") {
		return nil, projectError()
	}
	out := Object{}
	for k, v := range input {
		out[k] = v
	}
	if _, ok := out["enabled"].(bool); !ok {
		return nil, projectError()
	}
	if _, ok := out["purposes"]; !ok {
		out["purposes"] = []any{"conversation"}
	}
	purposes := func(v any) bool {
		values, ok := v.([]any)
		if !ok || len(values) < 1 || len(values) > 4 {
			return false
		}
		seen := []string{}
		for _, v := range values {
			s, ok := v.(string)
			if !ok || !contains([]string{"conversation", "reuse", "collaboration", "recruitment"}, s) || contains(seen, s) {
				return false
			}
			seen = append(seen, s)
		}
		return true
	}
	if !purposes(out["purposes"]) {
		return nil, projectError()
	}
	if _, ok := out["functions"]; !ok {
		out["functions"] = []any{}
	}
	values, ok := tags(out["functions"], false)
	if !ok {
		return nil, projectError()
	}
	out["functions"] = values
	if v, ok := out["temporary"]; ok && v != nil {
		t, ok := v.(map[string]any)
		if !ok || !strict(t, "until", "contact", "purposes", "functions") || !integer(t["until"], 1, 9007199254740991) || !contains([]string{"welcome", "paused"}, str(t, "contact")) {
			return nil, projectError()
		}
		if v, ok := t["purposes"]; ok && !purposes(v) {
			return nil, projectError()
		}
		if v, ok := t["functions"]; ok {
			values, ok := tags(v, false)
			if !ok {
				return nil, projectError()
			}
			t["functions"] = values
		}
	} else {
		out["temporary"] = nil
	}
	return out, nil
}

// ParseDiscoveryPreferences is the original shared discovery schema, without
// changing stored willingness or implying an authenticated caller.
func ParseDiscoveryPreferences(input Object) (Object, error) { return parseWish(input) }
func DefaultDiscoveryPreferences() Object {
	return Object{"enabled": false, "purposes": []any{"conversation"}, "functions": []any{}, "temporary": nil}
}
func (s *Service) effectiveWish(p Object) Object {
	t := obj(p, "temporary")
	if t != nil && num(t, "until") <= s.now() {
		t = nil
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
	return Object{"enabled": truth(p, "enabled") && (t == nil || str(t, "contact") != "paused"), "purposes": wishStrings(purposes), "functions": wishTags(functions), "temporaryUntil": until}
}
func (s *Service) EffectiveWishWithin(ctx context.Context, tx pgx.Tx, subject, project string, active bool, purposes []string) (Object, error) {
	if s.DiscoveryPreferences == nil {
		return nil, fail("discovery_preferences_unavailable", 503)
	}
	stored, e := s.DiscoveryPreferences(ctx, tx, subject)
	if e != nil {
		return nil, e
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(p) FROM project_preferences_v2 p WHERE project_id=$1 AND subject_id=$2", project, subject)
	if e != nil {
		return nil, e
	}
	var local Object
	if r != nil && r["settings"] != nil {
		local, e = parseWish(obj(r, "settings"))
		if e != nil {
			return nil, e
		}
	}
	base := stored
	if base == nil {
		base = Object{"enabled": active, "purposes": []any{"conversation"}, "functions": []any{}, "temporary": nil}
	}
	long := s.effectiveWish(base)
	out := Object{}
	for k, v := range long {
		out[k] = v
	}
	if local != nil {
		specific := s.effectiveWish(local)
		out["enabled"] = truth(long, "enabled") && truth(specific, "enabled")
		out["purposes"], out["functions"] = specific["purposes"], specific["functions"]
		if specific["temporaryUntil"] != nil {
			out["temporaryUntil"] = specific["temporaryUntil"]
		}
	}
	if purposes != nil {
		out["purposes"] = purposes
	}
	return out, nil
}
