package searchv2

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

type Object = map[string]any
type ordered = protocol.OrderedObject

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var capabilityPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)

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
func fields(o Object, keys ...string) *ordered {
	out := build()
	for _, k := range keys {
		if v, ok := o[k]; ok {
			out.Set(k, v)
		}
	}
	return out
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
func lower(s string) string { return cases.Lower(language.AmericanEnglish).String(s) }
func bad() error            { return fault.New("invalid_search_v2_query", 400) }
func encode(v any) []byte {
	raw, e := protocol.EncodeJS(v)
	if e != nil {
		panic(e)
	}
	return raw
}
func Scope(kind string) string {
	switch kind {
	case "task":
		return "assistance"
	case "proof":
		return "proof"
	case "capsule":
		return "capsules"
	case "worker", "hub":
		return "builders"
	default:
		return "history"
	}
}

// ParseQuery normalizes only the original typed source query envelope. Actual
// content and current authorization remain with each source's owning service.
func ParseQuery(raw []byte) (Object, error) {
	var input Object
	if protocol.Decode(raw, &input) != nil || !exact(input, []string{"type", "query"}, nil) {
		return nil, bad()
	}
	kind := text(input, "type")
	q := obj(input["query"])
	if q == nil {
		return nil, bad()
	}
	if kind == "case" || kind == "history" {
		parsed, e := historyv2.ParseSearchQuery(encode(q))
		if e != nil {
			return nil, bad()
		}
		return Object{"type": kind, "query": parsed}, nil
	}
	if !one(kind, "capsule", "proof", "task", "opportunity", "worker", "hub") {
		return nil, bad()
	}
	if kind == "opportunity" {
		candidate := Object{}
		for k, v := range q {
			candidate[k] = v
		}
		if _, present := candidate["limit"]; !present {
			candidate["limit"] = 8
		}
		normalized, e := opportunities.ParseQuery(candidate)
		if e != nil {
			return nil, bad()
		}
		context := fields(obj(normalized["context"]), "kind", "title", "functions", "technologies", "projectId")
		return Object{"type": kind, "query": build("context", context, "purposes", normalized["purposes"], "after", normalized["after"], "limit", normalized["limit"])}, nil
	}
	allowed := []string{"query", "after", "limit"}
	switch kind {
	case "capsule":
		allowed = append(allowed, "capabilityId", "authorId")
	case "proof":
		allowed = append(allowed, "subjectId", "conclusion")
	case "task":
		allowed = append(allowed, "view")
	case "worker", "hub":
		allowed = append(allowed, "ownerId")
	}
	if !exact(q, nil, allowed) {
		return nil, bad()
	}
	query := ""
	if v, ok := q["query"]; ok {
		value, ok := v.(string)
		if !ok {
			return nil, bad()
		}
		query = strings.TrimFunc(value, white)
	}
	if utf8.RuneCountInString(query) > 200 {
		return nil, bad()
	}
	if kind == "proof" || kind == "worker" || kind == "hub" {
		terms := map[string]bool{}
		for _, v := range strings.FieldsFunc(lower(query), white) {
			terms[v] = true
		}
		if len(terms) > 8 {
			return nil, bad()
		}
	}
	out := build()
	if kind == "task" {
		view := "open"
		if v, ok := q["view"]; ok {
			if !one(v, "open", "requested", "participating") {
				return nil, bad()
			}
			view = v.(string)
		}
		out.Set("view", view)
	}
	if v, ok := q["ownerId"]; ok {
		value, ok := v.(string)
		if !ok || !subjectPattern.MatchString(value) {
			return nil, bad()
		}
		out.Set("ownerId", v)
	}
	out.Set("query", query)
	for _, key := range []string{"capabilityId", "authorId", "subjectId", "conclusion"} {
		if v, ok := q[key]; ok {
			value, ok := v.(string)
			if !ok {
				return nil, bad()
			}
			switch key {
			case "capabilityId":
				if !capabilityPattern.MatchString(value) {
					return nil, bad()
				}
			case "authorId", "subjectId":
				if !subjectPattern.MatchString(value) {
					return nil, bad()
				}
			case "conclusion":
				if !one(v, "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure") {
					return nil, bad()
				}
			}
			out.Set(key, v)
		}
	}
	if v, ok := q["after"]; ok {
		value, ok := v.(string)
		if !ok || !uuidPattern.MatchString(value) {
			return nil, bad()
		}
		out.Set("after", v)
	}
	limit := int64(8)
	if v, ok := q["limit"]; ok {
		if !integer(v, 1, 20) {
			return nil, bad()
		}
		limit = number(q, "limit")
	}
	out.Set("limit", limit)
	return Object{"type": kind, "query": out}, nil
}
func ParseReference(raw []byte) (Object, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || !exact(o, []string{"search", "ref"}, nil) {
		return nil, bad()
	}
	search, e := ParseQuery(encode(o["search"]))
	if e != nil {
		return nil, e
	}
	ref := obj(o["ref"])
	if !exact(ref, []string{"id", "version"}, nil) || utf8.RuneCountInString(text(ref, "id")) < 1 || utf8.RuneCountInString(text(ref, "id")) > 160 || !hashPattern.MatchString(text(ref, "version")) {
		return nil, bad()
	}
	return Object{"search": search, "ref": fields(ref, "id", "version")}, nil
}
