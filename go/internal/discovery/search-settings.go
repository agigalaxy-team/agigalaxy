package discovery

import (
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"golang.org/x/text/cases"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

var rankingRules = map[string][]string{"relevance": {"words", "typo", "proximity", "attribute", "sort", "exactness"}, "newest": {"sort", "words", "typo", "proximity", "attribute", "exactness"}}
var fixedConstraints = Object{"currentSource": true, "anonymousPublic": true, "withdrawnExcluded": true, "expiredExcluded": true}

func jsSpace(r rune) bool {
	return r >= 9 && r <= 13 || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func normalizeTerm(value string) string {
	return strings.Join(strings.FieldsFunc(cases.Lower(language.English).String(strings.TrimFunc(norm.NFKC.String(value), jsSpace)), jsSpace), " ")
}
func utf16Less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
func jsSortedDistinct(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range values {
		if !seen[v] {
			out = append(out, v)
			seen[v] = true
		}
	}
	sort.Slice(out, func(i, j int) bool { return utf16Less(out[i], out[j]) })
	return out
}
func localeKeys(values []string) {
	// New drafts only. Existing persisted arrays are never resorted. The
	// deployment's effective ICU locale still needs its own baseline comparison;
	// x/text ordering is not asserted to be equivalent to arbitrary ICU locales.
	collator := collate.New(language.English)
	sort.SliceStable(values, func(i, j int) bool { return collator.CompareString(values[i], values[j]) < 0 })
}
func sameValue(a, b any) bool {
	x, e := identity.Canonical(a)
	if e != nil {
		return false
	}
	y, e := identity.Canonical(b)
	return e == nil && string(x) == string(y)
}
func settingsInvalid() error { return fault.New("invalid_search_quality_request", 400) }
func stringArray(value any) ([]string, bool) {
	switch v := value.(type) {
	case []string:
		return append([]string{}, v...), true
	case []any:
		out := []string{}
		for _, item := range v {
			s, ok := item.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	}
	return nil, false
}
func onlyKeys(value Object, allowed ...string) bool {
	for key := range value {
		found := false
		for _, candidate := range allowed {
			found = found || candidate == key
		}
		if !found {
			return false
		}
	}
	return true
}
func badTerm(value string) bool {
	return value == "__proto__" || value == "constructor" || value == "prototype"
}
func canonicalSettings(value Object) (Object, error) {
	if value == nil || !onlyKeys(value, "synonyms", "rankingMode", "fixedConstraints") || !sameValue(value["fixedConstraints"], fixedConstraints) {
		return nil, settingsInvalid()
	}
	mode := str(value, "rankingMode")
	if rankingRules[mode] == nil {
		return nil, settingsInvalid()
	}
	rows, ok := value["synonyms"].([]any)
	if !ok || len(rows) > 100 {
		return nil, settingsInvalid()
	}
	mapped := map[string][]string{}
	terms := []string{}
	word := func(v any) (string, error) {
		s, ok := v.(string)
		if !ok {
			return "", settingsInvalid()
		}
		s = strings.TrimFunc(s, jsSpace)
		if codePointLength(s) < 1 || codePointLength(s) > 80 {
			return "", settingsInvalid()
		}
		s = normalizeTerm(s)
		if s == "" || badTerm(s) {
			return "", settingsInvalid()
		}
		return s, nil
	}
	for _, item := range rows {
		row := object(item)
		if row == nil || !onlyKeys(row, "term", "alternatives") {
			return nil, settingsInvalid()
		}
		term, e := word(row["term"])
		if e != nil {
			return nil, e
		}
		if _, exists := mapped[term]; exists {
			return nil, settingsInvalid()
		}
		alternatives, ok := stringArray(row["alternatives"])
		if !ok || len(alternatives) < 1 || len(alternatives) > 20 {
			return nil, settingsInvalid()
		}
		normalized := []string{}
		for _, value := range alternatives {
			v, e := word(value)
			if e != nil {
				return nil, e
			}
			normalized = append(normalized, v)
		}
		mapped[term] = jsSortedDistinct(normalized)
		terms = append(terms, term)
	}
	localeKeys(terms)
	synonyms := []Object{}
	for _, term := range terms {
		synonyms = append(synonyms, Object{"term": term, "alternatives": mapped[term]})
	}
	return Object{"synonyms": synonyms, "rankingMode": mode, "fixedConstraints": fixedConstraints}, nil
}
func nativeSettings(settings Object) Object {
	synonyms := Object{}
	switch rows := settings["synonyms"].(type) {
	case []Object:
		for _, row := range rows {
			synonyms[str(row, "term")] = row["alternatives"]
		}
	case []any:
		for _, item := range rows {
			row := object(item)
			synonyms[str(row, "term")] = row["alternatives"]
		}
	}
	return Object{"synonyms": synonyms, "rankingRules": rankingRules[str(settings, "rankingMode")]}
}
func controlledSettings(value Object) (Object, error) {
	synonyms := object(value["synonyms"])
	rules, ok := stringArray(value["rankingRules"])
	if value == nil || synonyms == nil || !ok || len(rules) > 32 || len(synonyms) > 1000 {
		return nil, fail("discovery_engine_response_invalid")
	}
	for i, rule := range rules {
		if protocol.TextLength(rule) > 80 {
			return nil, fail("discovery_engine_response_invalid")
		}
		if rule == "attributeRank" {
			rules[i] = "attribute"
		}
	}
	clean := Object{}
	for term, value := range synonyms {
		key := normalizeTerm(term)
		if key == "" || protocol.TextLength(term) > 200 || badTerm(key) {
			return nil, fail("discovery_engine_response_invalid")
		}
		if _, exists := clean[key]; exists {
			return nil, fail("discovery_engine_response_invalid")
		}
		alternatives, ok := stringArray(value)
		if !ok || len(alternatives) > 100 {
			return nil, fail("discovery_engine_response_invalid")
		}
		normalized := []string{}
		for _, word := range alternatives {
			v := normalizeTerm(word)
			if v == "" || protocol.TextLength(word) > 200 {
				return nil, fail("discovery_engine_response_invalid")
			}
			normalized = append(normalized, v)
		}
		clean[key] = jsSortedDistinct(normalized)
	}
	return Object{"synonyms": clean, "rankingRules": rules}, nil
}
func sameNative(a, b Object) bool {
	x, e := controlledSettings(a)
	if e != nil {
		return false
	}
	y, e := controlledSettings(b)
	return e == nil && sameValue(x, y)
}
func editableSettings(value Object) Object {
	controlled, e := controlledSettings(value)
	if e != nil {
		return nil
	}
	mode := ""
	for key, rules := range rankingRules {
		if sameValue(controlled["rankingRules"], rules) {
			mode = key
			break
		}
	}
	if mode == "" {
		return nil
	}
	terms := []string{}
	for term := range object(controlled["synonyms"]) {
		terms = append(terms, term)
	}
	localeKeys(terms)
	synonyms := []any{}
	for _, term := range terms {
		synonyms = append(synonyms, Object{"term": term, "alternatives": object(controlled["synonyms"])[term]})
	}
	settings, e := canonicalSettings(Object{"synonyms": synonyms, "rankingMode": mode, "fixedConstraints": fixedConstraints})
	if e != nil {
		return nil
	}
	return settings
}
