package experiencereviews

import (
	"encoding/json"
	"math"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"

	whatwg "github.com/nlnwa/whatwg-url/url"
)

var uuidPattern = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var capabilityPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)
var isoPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$`)

func date(v any) (time.Time, error) {
	s, ok := v.(string)
	if ok && isoPattern.MatchString(s) {
		for _, format := range []string{time.RFC3339Nano, "2006-01-02T15:04Z"} {
			if t, e := time.Parse(format, s); e == nil {
				return t, nil
			}
		}
	}
	return time.Time{}, fail("invalid_experience_payload", 400)
}
func decodeValue(raw []byte) (any, error) { return jstext.DecodeJSON(raw) }
func units(value any) (jstext.String, bool) {
	switch v := value.(type) {
	case string:
		return jstext.From(v), true
	case jstext.String:
		return v, true
	}
	return nil, false
}
func trimField(o Object, key string, min, max int) bool {
	value, ok := units(o[key])
	if !ok {
		return false
	}
	value = value.Trim()
	if value.CodePointLen() < min || value.CodePointLen() > max {
		return false
	}
	if value.HasUnpaired() {
		o[key] = value
	} else {
		o[key] = value.Decoded()
	}
	return true
}
func optionalNote(o Object, key string, max int) bool {
	if _, exists := o[key]; !exists {
		return true
	}
	return trimField(o, key, 1, max)
}
func integer(v any, min int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= 9007199254740991
	case int64:
		return n >= min && n <= 9007199254740991
	case float64:
		return n >= float64(min) && n <= 9007199254740991 && math.Trunc(n) == n
	case json.Number:
		f, e := n.Float64()
		return e == nil && f >= float64(min) && f <= 9007199254740991 && math.Trunc(f) == f
	}
	return false
}
func boolField(o Object, key string) bool { _, ok := o[key].(bool); return ok }
func enum(value any, allowed ...string) bool {
	v, ok := value.(string)
	if !ok {
		return false
	}
	for _, a := range allowed {
		if a == v {
			return true
		}
	}
	return false
}
func noteArray(o Object, key string, min, max int) bool {
	a, ok := o[key].([]any)
	if !ok || len(a) < min || len(a) > max {
		return false
	}
	for i, v := range a {
		item := Object{"v": v}
		if !trimField(item, "v", 1, 1600) {
			return false
		}
		a[i] = item["v"]
	}
	return true
}
func ParseEvent(raw []byte) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_experience_payload", 400) }
	if len(raw) > 24000 {
		return invalid()
	}
	value, e := decodeValue(raw)
	if e != nil {
		return invalid()
	}
	p := object(value)
	if p == nil {
		return invalid()
	}
	common := []string{"id", "operationId", "expectedVersion", "reportedBy", "synthetic", "kind"}
	kind := str(p, "kind")
	switch kind {
	case "external-work", "challenge":
		required := append(common, "subjectId", "capabilityId", "source", "actualIntervention", "resultReference", "outcome", "scope", "limitations", "ownershipStatement")
		if !closed(p, required, []string{"reason", "expiresAt"}) || !subjectPattern.MatchString(str(p, "subjectId")) || !capabilityPattern.MatchString(str(p, "capabilityId")) || !enum(p["outcome"], "succeeded", "partial", "failed", "inconclusive", "conflicting") {
			return invalid()
		}
		for _, k := range []string{"actualIntervention", "resultReference", "scope", "ownershipStatement"} {
			if !trimField(p, k, 1, 1600) {
				return invalid()
			}
		}
		if !noteArray(p, "limitations", 1, 16) {
			return invalid()
		}
		source := object(p["source"])
		if !closed(source, []string{"system", "stableRecord", "originalAt", "originalAuthor", "contentVersion"}, []string{"links"}) || !trimField(source, "system", 1, 120) || !trimField(source, "stableRecord", 1, 1200) || !trimField(source, "originalAuthor", 1, 1600) || !trimField(source, "contentVersion", 1, 160) {
			return invalid()
		}
		if _, e = date(source["originalAt"]); e != nil {
			return invalid()
		}
		if links, ok := source["links"]; ok {
			a, ok := links.([]any)
			if !ok || len(a) > 16 {
				return invalid()
			}
			for _, v := range a {
				if _, ok := units(v); !ok {
					return invalid()
				}
				if _, e = whatwg.Parse(text(v)); e != nil {
					return invalid()
				}
			}
		} else {
			source["links"] = []any{}
		}
	case "review":
		required := append(common, "experienceRef", "capabilityId", "state", "scope", "observedAt", "checked", "method", "observations", "limitations", "sourceReferences", "relationship")
		if !closed(p, required, []string{"reason", "expiresAt"}) || !capabilityPattern.MatchString(str(p, "capabilityId")) || !enum(p["state"], "verified-in-scope", "rejected", "unavailable") || p["relationship"] != "non-party" {
			return invalid()
		}
		ref := object(p["experienceRef"])
		if !closed(ref, []string{"id", "version"}, nil) || !uuidPattern.MatchString(str(ref, "id")) || !integer(ref["version"], 1) {
			return invalid()
		}
		for _, k := range []string{"scope", "method", "observations"} {
			if !trimField(p, k, 1, 1600) {
				return invalid()
			}
		}
		if _, e = date(p["observedAt"]); e != nil {
			return invalid()
		}
		checked := object(p["checked"])
		if !closed(checked, []string{"source", "attribution", "actualIntervention", "result", "acceptanceOrIndependentCheck"}, nil) {
			return invalid()
		}
		for _, k := range []string{"source", "attribution", "actualIntervention", "result", "acceptanceOrIndependentCheck"} {
			if !boolField(checked, k) {
				return invalid()
			}
		}
		if !noteArray(p, "limitations", 1, 16) {
			return invalid()
		}
		refs, ok := p["sourceReferences"].([]any)
		if !ok || len(refs) < 1 || len(refs) > 16 {
			return invalid()
		}
		for i, v := range refs {
			r := Object{"v": v}
			if !trimField(r, "v", 1, 1200) {
				return invalid()
			}
			refs[i] = r["v"]
		}
	case "revoke":
		if !closed(p, append(common, "objectType", "reason"), nil) || !enum(p["objectType"], "experience", "review") || !trimField(p, "reason", 1, 1600) {
			return invalid()
		}
	default:
		return invalid()
	}
	if !uuidPattern.MatchString(str(p, "id")) || !uuidPattern.MatchString(str(p, "operationId")) || !integer(p["expectedVersion"], 0) || !subjectPattern.MatchString(str(p, "reportedBy")) || !boolField(p, "synthetic") || !optionalNote(p, "reason", 1600) {
		return invalid()
	}
	if v, exists := p["expiresAt"]; exists {
		if _, e = date(v); e != nil {
			return invalid()
		}
	}
	return p, nil
}
func ParseRead(input Object) error {
	if !closed(input, []string{"id"}, []string{"version"}) || !uuidPattern.MatchString(str(input, "id")) {
		return fail("invalid_experience_reference", 400)
	}
	if v, ok := input["version"]; ok && !integer(v, 1) {
		return fail("invalid_experience_reference", 400)
	}
	return nil
}
