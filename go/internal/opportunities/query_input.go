package opportunities

import (
	"encoding/json"
	"math"
	"unicode/utf8"
)

func safeInt(v any, min, max int64) (int64, bool) {
	var n float64
	switch x := v.(type) {
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case float64:
		n = x
	case json.Number:
		n, _ = x.Float64()
	default:
		return 0, false
	}
	return int64(n), !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && n >= float64(min) && n <= float64(max)
}
func parseOptions(input Object, detail bool) (Object, error) {
	keys := []string{"context", "purposes", "after", "limit"}
	if detail {
		keys = []string{"context", "purposes", "opportunityRef", "experienceAfter", "experienceLimit"}
	}
	if input == nil || !exact(input, keys...) {
		return nil, invalid()
	}
	out := Object{}
	for k, v := range input {
		out[k] = v
	}
	context, e := ParseContext(obj(out, "context"))
	if e != nil {
		return nil, invalid()
	}
	out["context"] = context
	if _, ok := out["purposes"]; !ok {
		out["purposes"] = []any{"conversation"}
	}
	purposes, ok := out["purposes"].([]any)
	if !ok || len(purposes) < 1 || len(purposes) > 4 {
		return nil, invalid()
	}
	seen := []string{}
	for _, v := range purposes {
		p, ok := v.(string)
		if !ok || !has([]string{"conversation", "reuse", "collaboration", "recruitment"}, p) || has(seen, p) {
			return nil, invalid()
		}
		seen = append(seen, p)
	}
	afterKey, limitKey := "after", "limit"
	if detail {
		ref, e := ParseRef(obj(out, "opportunityRef"))
		if e != nil {
			return nil, invalid()
		}
		out["opportunityRef"] = ref
		afterKey, limitKey = "experienceAfter", "experienceLimit"
	}
	if _, ok := out[afterKey]; !ok {
		out[afterKey] = nil
	}
	if v := out[afterKey]; v != nil {
		s, ok := v.(string)
		if !ok || utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > 4096 {
			return nil, invalid()
		}
	}
	if _, ok := out[limitKey]; !ok {
		out[limitKey] = int64(20)
	}
	n, ok := safeInt(out[limitKey], 1, 20)
	if !ok {
		return nil, invalid()
	}
	out[limitKey] = n
	return out, nil
}
func ParseQuery(input Object) (Object, error)  { return parseOptions(input, false) }
func ParseDetail(input Object) (Object, error) { return parseOptions(input, true) }
