package information

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

type Object = map[string]any
type ordered = protocol.OrderedObject

const maxSafe int64 = 9007199254740991

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var rulePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`)
var versionPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){0,2}$`)
var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)

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
	case int64:
		return n
	case int32:
		return int64(n)
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func list(v any) []any {
	switch v := v.(type) {
	case []any:
		return v
	case []Object:
		out := []any{}
		for _, v := range v {
			out = append(out, v)
		}
		return out
	}
	return nil
}
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
	case int64:
		f = float64(v)
	case int:
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
func white(r rune) bool {
	return r >= 0x2000 && r <= 0x200a || strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff", r)
}
func encode(v any) []byte {
	raw, e := protocol.EncodeJS(v)
	if e != nil {
		panic(e)
	}
	return raw
}
func Digest(v any) (string, error) {
	raw, e := identity.Canonical(v)
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
func parseHonor(o Object) (Object, error) {
	bad := func() (Object, error) { return nil, fault.New("invalid_information_query", 400) }
	if !exact(o, []string{"ruleId", "ruleVersion", "subjectId"}, []string{"after", "limit", "expectedFingerprint", "includeSimulation"}) || !rulePattern.MatchString(text(o, "ruleId")) || !versionPattern.MatchString(text(o, "ruleVersion")) || !subjectPattern.MatchString(text(o, "subjectId")) {
		return bad()
	}
	out := Object{"ruleId": o["ruleId"], "ruleVersion": o["ruleVersion"], "subjectId": o["subjectId"]}
	for _, k := range []string{"after", "expectedFingerprint"} {
		if v, ok := o[k]; ok {
			value, ok := v.(string)
			if !ok || !hashPattern.MatchString(value) {
				return bad()
			}
			out[k] = v
		}
	}
	limit := int64(8)
	if v, ok := o["limit"]; ok {
		if !integer(v, 1, 20) {
			return bad()
		}
		limit = number(o, "limit")
	}
	out["limit"] = limit
	simulation := false
	if v, ok := o["includeSimulation"]; ok {
		value, ok := v.(bool)
		if !ok {
			return bad()
		}
		simulation = value
	}
	out["includeSimulation"] = simulation
	return out, nil
}
func parseSource(v any) (Object, error) {
	o := obj(v)
	if !exact(o, []string{"kind", "request"}, nil) {
		return nil, fault.New("invalid_information_query", 400)
	}
	var request Object
	var e error
	switch o["kind"] {
	case "search":
		request, e = searchv2.ParseQuery(encode(o["request"]))
	case "reference":
		request, e = searchv2.ParseReference(encode(o["request"]))
	case "honor":
		request, e = parseHonor(obj(o["request"]))
	default:
		return nil, fault.New("invalid_information_query", 400)
	}
	if e != nil {
		return nil, fault.New("invalid_information_query", 400)
	}
	return Object{"kind": o["kind"], "request": request}, nil
}
func parseSelections(v any, max int) ([]any, error) {
	a, ok := v.([]any)
	if !ok || len(a) < 1 || len(a) > max {
		return nil, fault.New("invalid_information_query", 400)
	}
	out := []any{}
	seen := map[string]bool{}
	for _, v := range a {
		o := obj(v)
		key := text(o, "key")
		if !exact(o, []string{"key", "source"}, nil) || !keyPattern.MatchString(key) || seen[key] {
			return nil, fault.New("invalid_information_query", 400)
		}
		seen[key] = true
		source, e := parseSource(o["source"])
		if e != nil {
			return nil, e
		}
		out = append(out, Object{"key": key, "source": source})
	}
	return out, nil
}
func purpose(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = strings.TrimFunc(s, white)
	return s, s != "" && utf8.RuneCountInString(s) <= 300
}
func ParseQuery(raw []byte) (Object, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || !exact(o, []string{"purpose", "sources"}, []string{"queryId"}) {
		return nil, fault.New("invalid_information_query", 400)
	}
	p, ok := purpose(o["purpose"])
	if !ok {
		return nil, fault.New("invalid_information_query", 400)
	}
	sources, e := parseSelections(o["sources"], 8)
	if e != nil {
		return nil, e
	}
	out := Object{"purpose": p, "sources": sources}
	if v, ok := o["queryId"]; ok {
		value, ok := v.(string)
		if !ok || !hashPattern.MatchString(value) {
			return nil, fault.New("invalid_information_query", 400)
		}
		out["queryId"] = v
	}
	return out, nil
}
func Scope(source Object) string {
	if source["kind"] == "honor" {
		return "history"
	}
	request := obj(source["request"])
	if source["kind"] == "reference" {
		request = obj(request["search"])
	}
	return searchv2.Scope(text(request, "type"))
}
func clone(v any) any {
	out, e := protocol.DecodeOrdered(encode(v))
	if e != nil {
		panic(e)
	}
	return out
}
func Base(source Object) any {
	out := clone(source)
	o := obj(out)
	query := obj(o["request"])
	if o["kind"] == "reference" {
		query = obj(query["search"])
	}
	if o["kind"] != "honor" {
		query = obj(query["query"])
	}
	delete(query, "after")
	delete(query, "expectedFingerprint")
	return plain(out)
}

// plain discards only serialization metadata after property removals; digests
// here use the original canonical JSON protocol, not member insertion order.
func plain(v any) any {
	if o, ok := v.(*ordered); ok {
		out := Object{}
		for k, v := range o.Values() {
			out[k] = plain(v)
		}
		return out
	}
	if a, ok := v.([]any); ok {
		out := []any{}
		for _, v := range a {
			out = append(out, plain(v))
		}
		return out
	}
	return v
}
func WithCursor(source Object, after any) Object {
	out := obj(clone(source))
	var query Object
	switch out["kind"] {
	case "honor":
		query = obj(out["request"])
	case "search":
		query = obj(obj(out["request"])["query"])
	}
	if query != nil {
		if value, ok := after.(string); ok && value != "" {
			query["after"] = value
		} else {
			delete(query, "after")
		}
	}
	return plain(build("kind", out["kind"], "request", out["request"])).(Object)
}
