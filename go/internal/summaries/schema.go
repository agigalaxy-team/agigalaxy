package summaries

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"math"
	"math/big"
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
func object(v any) Object           { o, _ := v.(map[string]any); return o }
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
var sequencePattern = regexp.MustCompile(`^\d+$`)

func boundedText(v any, min, max int) bool {
	var s jstext.String
	switch v := v.(type) {
	case string:
		s = jstext.From(v)
	case jstext.String:
		s = v
	default:
		return false
	}
	n := s.CodePointLen()
	return n >= min && n <= max
}
func sourceRef(v any) bool {
	o := object(v)
	return exact(o, []string{"messageId", "revision"}, nil) && uuidPattern.MatchString(str(o, "messageId")) && integer(o["revision"], 1)
}
func sourceRefs(v any) bool {
	a, ok := v.([]any)
	if !ok || len(a) > 100 {
		return false
	}
	for _, v := range a {
		if !sourceRef(v) {
			return false
		}
	}
	return true
}
func parseContent(v any) (Object, error) {
	bad := func() (Object, error) { return nil, fail("invalid_personal_summary_request", 400) }
	o := object(v)
	if !exact(o, []string{"generator", "coverage", "fragments", "keyMessageRefs"}, nil) {
		return bad()
	}
	g := object(o["generator"])
	if !exact(g, []string{"kind"}, []string{"label"}) || (g["kind"] != "user-model" && g["kind"] != "manual") {
		return bad()
	}
	if label, ok := g["label"]; ok && !boundedText(label, 0, 120) {
		return bad()
	}
	coverage := object(o["coverage"])
	if !exact(coverage, []string{"fromSequence", "throughSequence", "complete"}, nil) || !sequencePattern.MatchString(str(coverage, "fromSequence")) || !sequencePattern.MatchString(str(coverage, "throughSequence")) {
		return bad()
	}
	if _, ok := coverage["complete"].(bool); !ok {
		return bad()
	}
	from, _ := new(big.Int).SetString(str(coverage, "fromSequence"), 10)
	through, _ := new(big.Int).SetString(str(coverage, "throughSequence"), 10)
	if from.Cmp(through) > 0 {
		return bad()
	}
	fragments, ok := o["fragments"].([]any)
	if !ok || len(fragments) > 100 || !sourceRefs(o["keyMessageRefs"]) {
		return bad()
	}
	seen := map[string]bool{}
	for _, v := range fragments {
		f := object(v)
		if !exact(f, []string{"id", "kind", "text", "sourceRefs"}, nil) || !uuidPattern.MatchString(str(f, "id")) || seen[str(f, "id")] || (f["kind"] != "derived" && f["kind"] != "personal-note") || !boundedText(f["text"], 1, 8000) || !sourceRefs(f["sourceRefs"]) || f["kind"] == "derived" && len(array(f["sourceRefs"])) == 0 {
			return bad()
		}
		seen[str(f, "id")] = true
	}
	raw, e := jstext.EncodeJSON(o)
	if e != nil || len(raw) > 65536 {
		return bad()
	}
	return o, nil
}
func Parse(action string, in Object) (Object, error) {
	bad := func() (Object, error) { return nil, fail("invalid_personal_summary_request", 400) }
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
		if !exact(in, []string{"expectedRevision", "endpoint", "enabled"}, []string{"roomIds", "includeExisting"}) || !integer(in["expectedRevision"], 0) {
			return bad()
		}
		if _, e := whatwg.Parse(str(in, "endpoint")); e != nil {
			return bad()
		}
		if _, ok := in["enabled"].(bool); !ok {
			return bad()
		}
		if rooms := in["roomIds"]; rooms != nil {
			a, ok := rooms.([]any)
			if !ok || len(a) > 256 {
				return bad()
			}
			seen := map[string]bool{}
			for _, v := range a {
				id, _ := v.(string)
				if !uuidPattern.MatchString(id) || seen[id] {
					return bad()
				}
				seen[id] = true
			}
		} else {
			out["roomIds"] = nil
		}
		if v, ok := in["includeExisting"]; ok {
			if _, ok := v.(bool); !ok {
				return bad()
			}
		} else {
			out["includeExisting"] = true
		}
	case "get", "delete":
		if !uuidPattern.MatchString(str(in, "summaryId")) {
			return bad()
		}
		if action == "delete" && !integer(in["expectedRevision"], 0) {
			return bad()
		}
	case "receipt":
		if !exact(in, []string{"summaryId", "versionId"}, nil) || !uuidPattern.MatchString(str(in, "summaryId")) || !uuidPattern.MatchString(str(in, "versionId")) {
			return bad()
		}
	case "list":
		if !exact(in, nil, []string{"after", "limit"}) {
			return bad()
		}
		if _, ok := in["after"]; ok && !uuidPattern.MatchString(str(in, "after")) {
			return bad()
		}
		if v, ok := in["limit"]; ok {
			if !integer(v, 1) || number(v) > 20 {
				return bad()
			}
		} else {
			out["limit"] = 10
		}
	case "sources":
		if !exact(in, []string{"roomId", "refs"}, nil) || !uuidPattern.MatchString(str(in, "roomId")) || !sourceRefs(in["refs"]) {
			return bad()
		}
	case "put":
		if !exact(in, []string{"versionId", "summaryId", "roomId", "baseRevision", "preferenceRevision", "content"}, []string{"resolveVersionIds"}) || !uuidPattern.MatchString(str(in, "versionId")) || !uuidPattern.MatchString(str(in, "summaryId")) || !uuidPattern.MatchString(str(in, "roomId")) || !integer(in["baseRevision"], 0) || !integer(in["preferenceRevision"], 0) {
			return bad()
		}
		content, e := parseContent(in["content"])
		if e != nil {
			return nil, e
		}
		out["content"] = content
		if v, ok := in["resolveVersionIds"]; ok {
			a, ok := v.([]any)
			if !ok || len(a) > 100 {
				return bad()
			}
			for _, v := range a {
				id, _ := v.(string)
				if !uuidPattern.MatchString(id) {
					return bad()
				}
			}
		} else {
			out["resolveVersionIds"] = []any{}
		}
	default:
		return bad()
	}
	return out, nil
}

func digestIntent(v any) (string, error) {
	raw, e := identity.Canonical(v)
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
