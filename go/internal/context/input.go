package contextdata

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/selectedtext"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

type Object = map[string]any
type ordered = protocol.OrderedObject

const maxSafe int64 = 9007199254740991

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func obj(v any) Object {
	switch v := v.(type) {
	case Object:
		return v
	case *ordered:
		return v.Values()
	}
	return nil
}
func text(o Object, k string) string { s, _ := o[k].(string); return s }
func number(o Object, k string) int64 {
	switch n := o[k].(type) {
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func list(v any) []any { a, _ := v.([]any); return a }
func build(kv ...any) *ordered {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
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
func integer(v any, min, max int64) bool {
	var f float64
	switch v := v.(type) {
	case int:
		f = float64(v)
	case int64:
		f = float64(v)
	case float64:
		f = v
	case json.Number:
		var e error
		f, e = v.Float64()
		if e != nil {
			return false
		}
	default:
		return false
	}
	return !math.IsInf(f, 0) && math.Trunc(f) == f && f >= float64(min) && f <= float64(max)
}
func white(r rune) bool {
	return r >= 0x2000 && r <= 0x200a || strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff", r)
}
func trimmed(v any, max int) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = strings.TrimFunc(s, white)
	return s, s != "" && utf8.RuneCountInString(s) <= max
}
func fields(o Object, keys ...string) *ordered {
	out := build()
	for _, k := range keys {
		if v, ok := o[k]; ok {
			out.Set(k, v)
		}
	}
	return out
}
func parseGrant(payload string, v2 bool) (*ordered, error) {
	code, max := "invalid_context_payload", 16000
	if v2 {
		code, max = "invalid_context_v2_payload", 40000
	}
	invalid := func() (*ordered, error) { return nil, fault.New(code, 400) }
	var o Object
	if len(payload) > max || protocol.Decode([]byte(payload), &o) != nil {
		return invalid()
	}
	keys := []string{"id", "assistanceId", "caseId", "participantId", "scope", "scopeEventId", "expiresAt", "materials"}
	if v2 {
		keys = []string{"schemaVersion", "id", "taskId", "participationId", "participantId", "scopeVersion", "scopeEventId", "expiresAt", "materials"}
	}
	if !exact(o, keys, nil) || !subjectPattern.MatchString(text(o, "participantId")) || !integer(o["expiresAt"], 1, maxSafe) {
		return invalid()
	}
	for _, k := range []string{"id", "scopeEventId"} {
		if !uuidPattern.MatchString(text(o, k)) {
			return invalid()
		}
	}
	if v2 {
		if !integer(o["schemaVersion"], 2, 2) || !integer(o["scopeVersion"], 1, maxSafe) || !uuidPattern.MatchString(text(o, "taskId")) || !uuidPattern.MatchString(text(o, "participationId")) {
			return invalid()
		}
	} else {
		if !uuidPattern.MatchString(text(o, "assistanceId")) || !uuidPattern.MatchString(text(o, "caseId")) {
			return invalid()
		}
		scope, ok := trimmed(o["scope"], 1200)
		if !ok {
			return invalid()
		}
		o["scope"] = scope
	}
	materials, ok := o["materials"].([]any)
	if !ok || len(materials) < 1 || len(materials) > 8 {
		return invalid()
	}
	seen := map[string]bool{}
	outMaterials := []any{}
	for _, v := range materials {
		m := obj(v)
		label, ok := trimmed(m["label"], 160)
		content, contentOK := m["content"].(string)
		id := text(m, "id")
		if !exact(m, []string{"id", "label", "mediaType", "content"}, nil) || !ok || !contentOK || content == "" || !selectedtext.Valid(content) || !uuidPattern.MatchString(id) || seen[id] || m["mediaType"] != "text/plain" {
			return invalid()
		}
		seen[id] = true
		outMaterials = append(outMaterials, build("id", id, "label", label, "mediaType", "text/plain", "content", content))
	}
	out := fields(o, keys...)
	out.Set("materials", outMaterials)
	return out, nil
}
func parseEvent(payload string, v2 bool) (*ordered, error) {
	code, max := "invalid_context_payload", 16000
	if v2 {
		code, max = "invalid_context_v2_payload", 40000
	}
	invalid := func() (*ordered, error) { return nil, fault.New(code, 400) }
	var o Object
	if len(payload) > max || protocol.Decode([]byte(payload), &o) != nil {
		return invalid()
	}
	keys := []string{"id", "grantId", "assistanceId", "scopeEventId", "materialsHash"}
	if v2 {
		keys = []string{"schemaVersion", "id", "grantId", "taskId", "participationId", "scopeVersion", "materialsHash", "kind"}
	}
	if !exact(o, keys, nil) || !hashPattern.MatchString(text(o, "materialsHash")) {
		return invalid()
	}
	for _, k := range []string{"id", "grantId"} {
		if !uuidPattern.MatchString(text(o, k)) {
			return invalid()
		}
	}
	if v2 {
		if !integer(o["schemaVersion"], 2, 2) || !integer(o["scopeVersion"], 1, maxSafe) || !uuidPattern.MatchString(text(o, "taskId")) || !uuidPattern.MatchString(text(o, "participationId")) || !one(o["kind"], "accept", "decline", "revoke") {
			return invalid()
		}
	} else {
		if !uuidPattern.MatchString(text(o, "assistanceId")) || !uuidPattern.MatchString(text(o, "scopeEventId")) {
			return invalid()
		}
	}
	return fields(o, keys...), nil
}
func one(v any, values ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, v := range values {
		if s == v {
			return true
		}
	}
	return false
}
func envelope(raw []byte) (Object, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || o == nil {
		return nil, fault.New("invalid_request", 400)
	}
	return o, nil
}
func parseQuery(raw []byte, kind string, v2 bool) (Object, error) {
	o, e := envelope(raw)
	bad := func() (Object, error) { return nil, fault.New("invalid_context_query", 400) }
	if e != nil {
		return bad()
	}
	if kind == "receipt" {
		keys := []string{"grantId", "eventId", "payloadHash"}
		if !v2 {
			keys = append(keys, "kind")
		}
		if !exact(o, keys, nil) || !uuidPattern.MatchString(text(o, "grantId")) || !uuidPattern.MatchString(text(o, "eventId")) || !hashPattern.MatchString(text(o, "payloadHash")) || !v2 && (!one(o["kind"], "grant", "accept") || o["kind"] == "grant" && o["eventId"] != o["grantId"]) {
			return bad()
		}
		return o, nil
	}
	if !v2 {
		if !uuidPattern.MatchString(text(o, "assistanceId")) {
			return bad()
		}
		return o, nil
	}
	if !exact(o, []string{"taskId"}, []string{"participationId", "after", "limit"}) || !uuidPattern.MatchString(text(o, "taskId")) {
		return bad()
	}
	for _, k := range []string{"participationId", "after"} {
		if v, ok := o[k]; ok {
			s, ok := v.(string)
			if !ok || !uuidPattern.MatchString(s) {
				return bad()
			}
		}
	}
	if v, ok := o["limit"]; ok {
		if !integer(v, 1, 50) {
			return bad()
		}
	} else {
		o["limit"] = int64(20)
	}
	return o, nil
}
