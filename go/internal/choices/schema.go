package choices

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"math"
	"regexp"
)

type Object = map[string]any

func fail(c string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(c, n)
}
func object(v any) Object {
	switch v := v.(type) {
	case Object:
		return v
	case *protocol.OrderedObject:
		return v.Values()
	}
	return nil
}
func str(o Object, k string) string { s, _ := o[k].(string); return s }
func array(v any) []any             { a, _ := v.([]any); return a }
func number(v any) int64 {
	switch v := v.(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Float64()
		return int64(n)
	}
	return 0
}
func exact(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	keys := map[string]bool{}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
		keys[k] = true
	}
	for _, k := range optional {
		keys[k] = true
	}
	for k := range o {
		if !keys[k] {
			return false
		}
	}
	return true
}
func integer(v any, min float64) bool {
	var n float64
	switch v := v.(type) {
	case float64:
		n = v
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	default:
		return false
	}
	return n >= min && n <= 9007199254740991 && !math.IsInf(n, 0) && !math.IsNaN(n) && math.Trunc(n) == n
}

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func text(v any) (jstext.String, bool) {
	switch v := v.(type) {
	case string:
		return jstext.From(v), true
	case jstext.String:
		return v, true
	}
	return nil, false
}
func boundedText(v any, max int, trim bool) (any, bool) {
	s, ok := text(v)
	if !ok {
		return nil, false
	}
	if trim {
		s = s.Trim()
	}
	if s.CodePointLen() < 1 || s.CodePointLen() > max {
		return nil, false
	}
	if s.HasUnpaired() {
		return s, true
	}
	return s.Decoded(), true
}
func key(r Object) string {
	b, _ := protocol.EncodeJS(r["id"])
	return str(r, "type") + ":" + string(b) + ":" + str(r, "version")
}
func reference(v any) (Object, bool) {
	o := object(v)
	if !exact(o, []string{"type", "id", "version"}, nil) || !hashPattern.MatchString(str(o, "version")) {
		return nil, false
	}
	switch str(o, "type") {
	case "history", "case", "capsule", "task", "opportunity", "proof", "worker", "hub":
	default:
		return nil, false
	}
	id, ok := boundedText(o["id"], 160, false)
	if !ok {
		return nil, false
	}
	return Object{"type": o["type"], "id": id, "version": o["version"]}, true
}

func digestIntent(v any) (string, error) {
	b, e := identity.Canonical(v)
	if e != nil {
		return "", e
	}
	return identity.Digest(b), nil
}
func parseContent(v any) (Object, error) {
	o := object(v)
	bad := func() (Object, error) { return nil, fail("invalid_choice_snapshot_request", 400) }
	if !exact(o, []string{"localVersion", "localTaskRef", "visibleRationale", "rationaleAuthor", "candidateRefs", "selectedRefs", "resultRefs"}, nil) || !integer(o["localVersion"], 1) || (o["rationaleAuthor"] != "user" && o["rationaleAuthor"] != "user-agent") {
		return bad()
	}
	task, ok := boundedText(o["localTaskRef"], 300, true)
	if !ok {
		return bad()
	}
	rationale, ok := boundedText(o["visibleRationale"], 1200, true)
	if !ok {
		return bad()
	}
	out := Object{"localVersion": o["localVersion"], "localTaskRef": task, "visibleRationale": rationale, "rationaleAuthor": o["rationaleAuthor"]}
	seen := map[string]bool{}
	for _, name := range []string{"candidateRefs", "selectedRefs"} {
		values, ok := o[name].([]any)
		if !ok || len(values) > 64 || name == "candidateRefs" && len(values) == 0 {
			return bad()
		}
		result := []any{}
		for _, v := range values {
			r, ok := reference(v)
			if !ok {
				return bad()
			}
			k := key(r)
			if name == "candidateRefs" {
				if seen[k] {
					return bad()
				}
				seen[k] = true
			} else if !seen[k] {
				return bad()
			}
			result = append(result, r)
		}
		out[name] = result
	}
	values, ok := o["resultRefs"].([]any)
	if !ok || len(values) > 16 {
		return bad()
	}
	results := []any{}
	for _, v := range values {
		r := object(v)
		if !exact(r, []string{"caseId", "id", "version"}, nil) || !uuidPattern.MatchString(str(r, "caseId")) || !uuidPattern.MatchString(str(r, "id")) || !integer(r["version"], 1) {
			return bad()
		}
		results = append(results, r)
	}
	out["resultRefs"] = results
	ordered := protocol.NewOrderedObject()
	for _, k := range []string{"localVersion", "localTaskRef", "visibleRationale", "rationaleAuthor", "candidateRefs", "selectedRefs", "resultRefs"} {
		ordered.Set(k, out[k])
	}
	raw, e := jstext.EncodeJSON(ordered)
	if e != nil || len(raw) > 32768 {
		return bad()
	}
	return out, nil
}
func Parse(action string, in Object) (Object, error) {
	bad := func() (Object, error) { return nil, fail("invalid_choice_snapshot_request", 400) }
	out := Object{}
	for k, v := range in {
		out[k] = v
	}
	switch action {
	case "preferences/read":
		if !exact(in, nil, nil) {
			return bad()
		}
	case "preferences/save":
		if !exact(in, []string{"endpoint", "expectedRevision", "enabled", "snapshotIds"}, nil) || !integer(in["expectedRevision"], 0) {
			return bad()
		}
		if _, e := whatwg.Parse(str(in, "endpoint")); e != nil {
			return bad()
		}
		enabled, ok := in["enabled"].(bool)
		ids, okIDs := in["snapshotIds"].([]any)
		if !ok || !okIDs || len(ids) > 256 || enabled && len(ids) == 0 {
			return bad()
		}
		seen := map[string]bool{}
		for _, v := range ids {
			id, _ := v.(string)
			if !uuidPattern.MatchString(id) || seen[id] {
				return bad()
			}
			seen[id] = true
		}
	case "get":
		if !exact(in, []string{"snapshotId"}, nil) || !uuidPattern.MatchString(str(in, "snapshotId")) {
			return bad()
		}
	case "delete":
		if !exact(in, []string{"snapshotId", "expectedRevision"}, nil) || !uuidPattern.MatchString(str(in, "snapshotId")) || !integer(in["expectedRevision"], 0) {
			return bad()
		}
	case "receipt":
		if !exact(in, []string{"snapshotId", "versionId", "requestHash"}, nil) || !uuidPattern.MatchString(str(in, "snapshotId")) || !uuidPattern.MatchString(str(in, "versionId")) || !hashPattern.MatchString(str(in, "requestHash")) {
			return bad()
		}
	case "list":
		if !exact(in, nil, []string{"after", "limit"}) {
			return bad()
		}
		if v, ok := in["after"]; ok {
			if _, ok := v.(string); !ok || !uuidPattern.MatchString(str(in, "after")) {
				return bad()
			}
		}
		if v, ok := in["limit"]; ok {
			if !integer(v, 1) || number(v) > 20 {
				return bad()
			}
		} else {
			out["limit"] = 8
		}
	case "put":
		if !exact(in, []string{"snapshotId", "versionId", "baseRevision", "preferenceRevision", "content", "witnesses"}, []string{"resolveVersionIds"}) || !uuidPattern.MatchString(str(in, "snapshotId")) || !uuidPattern.MatchString(str(in, "versionId")) || !integer(in["baseRevision"], 0) || !integer(in["preferenceRevision"], 1) {
			return bad()
		}
		content, e := parseContent(in["content"])
		if e != nil {
			return nil, e
		}
		out["content"] = content
		witnesses, ok := in["witnesses"].([]any)
		if !ok || len(witnesses) < 1 || len(witnesses) > 64 {
			return bad()
		}
		parsed := []any{}
		for _, v := range witnesses {
			b, e := protocol.EncodeJS(v)
			if e != nil {
				return bad()
			}
			w, e := searchv2.ParseReference(b)
			if e != nil {
				return bad()
			}
			parsed = append(parsed, w)
		}
		out["witnesses"] = parsed
		ids := []any{}
		if v, ok := in["resolveVersionIds"]; ok {
			var good bool
			ids, good = v.([]any)
			if !good || len(ids) > 64 {
				return bad()
			}
		}
		seen := map[string]bool{}
		for _, v := range ids {
			id, _ := v.(string)
			if !uuidPattern.MatchString(id) || seen[id] {
				return bad()
			}
			seen[id] = true
		}
		out["resolveVersionIds"] = ids
	default:
		return bad()
	}
	return out, nil
}
