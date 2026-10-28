package historyv2

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type Object = map[string]any
type ordered = protocol.OrderedObject

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var capabilityPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)
var isoPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$`)

func obj(v any) Object {
	switch v := v.(type) {
	case Object:
		return v
	case *ordered:
		return v.Values()
	}
	return nil
}
func str(o Object, k string) string { v, _ := o[k].(string); return v }
func num(o Object, k string) int64 {
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
func arr(v any) []any {
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
func build(fields ...any) *ordered {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(fields); i += 2 {
		o.Set(fields[i].(string), fields[i+1])
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
func one(v any, keys ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, k := range keys {
		if s == k {
			return true
		}
	}
	return false
}
func white(r rune) bool {
	return r >= 0x2000 && r <= 0x200a || strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff", r)
}
func lower(s string) string { return cases.Lower(language.AmericanEnglish).String(s) }
func finiteInteger(v any, min, max int64) bool {
	var n float64
	switch v := v.(type) {
	case json.Number:
		var e error
		n, e = v.Float64()
		if e != nil {
			return false
		}
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case float64:
		n = v
	default:
		return false
	}
	return !math.IsInf(n, 0) && math.Trunc(n) == n && n >= float64(min) && n <= float64(max)
}
func millis(s string) (int64, bool) {
	if !isoPattern.MatchString(s) {
		return 0, false
	}
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}
func parseQuery(raw []byte) (*ordered, error) {
	return parseQueryMode(raw, false)
}

// ParseSearchQuery is the original SearchV2 history-source schema. It leaves
// public History's required subject and page defaults unchanged.
func ParseSearchQuery(raw []byte) (*ordered, error) { return parseQueryMode(raw, true) }
func parseQueryMode(raw []byte, search bool) (*ordered, error) {
	invalid := func() (*ordered, error) { return nil, fault.New("invalid_history_v2_query", 400) }
	var o Object
	required, optional := []string{"subjectId"}, []string{"query", "capabilityId", "timeWindow", "context", "after", "limit"}
	if search {
		required = nil
		optional = append(optional, "subjectId")
	}
	if protocol.Decode(raw, &o) != nil || !exact(o, required, optional) {
		return invalid()
	}
	if value, present := o["subjectId"]; present {
		value, ok := value.(string)
		if !ok || !subjectPattern.MatchString(value) {
			return invalid()
		}
	}
	query := ""
	if v, ok := o["query"]; ok {
		var good bool
		query, good = v.(string)
		if !good {
			return invalid()
		}
		query = strings.TrimFunc(query, white)
	}
	if utf8.RuneCountInString(query) > 200 || len(strings.FieldsFunc(query, white)) > 8 {
		return invalid()
	}
	out := build()
	if value, present := o["subjectId"]; present {
		out.Set("subjectId", value)
	}
	out.Set("query", query)
	if v, ok := o["capabilityId"]; ok {
		s, ok := v.(string)
		if !ok || !capabilityPattern.MatchString(s) {
			return invalid()
		}
		out.Set("capabilityId", s)
	}
	window := build("kind", "all-visible")
	if v, ok := o["timeWindow"]; ok {
		w := obj(v)
		if w == nil {
			return invalid()
		}
		if one(w["kind"], "all-visible", "90-days", "365-days") {
			if !exact(w, []string{"kind"}, nil) {
				return invalid()
			}
			window = build("kind", w["kind"])
		} else if w["kind"] == "custom" {
			if !exact(w, []string{"kind", "from", "before"}, nil) {
				return invalid()
			}
			from, ok1 := millis(str(w, "from"))
			before, ok2 := millis(str(w, "before"))
			if !ok1 || !ok2 || from >= before {
				return invalid()
			}
			window = build("kind", "custom", "from", w["from"], "before", w["before"])
		} else {
			return invalid()
		}
	}
	out.Set("timeWindow", window)
	if v, ok := o["context"]; ok {
		c := obj(v)
		if !exact(c, nil, []string{"taskId", "environment"}) {
			return invalid()
		}
		context := build()
		if v, ok := c["taskId"]; ok {
			s, ok := v.(string)
			if !ok || !uuidPattern.MatchString(s) {
				return invalid()
			}
			context.Set("taskId", s)
		}
		if v, ok := c["environment"]; ok {
			s, ok := v.(string)
			if !ok {
				return invalid()
			}
			s = strings.TrimFunc(s, white)
			if utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > 160 {
				return invalid()
			}
			context.Set("environment", s)
		}
		out.Set("context", context)
	}
	var after any
	if v, ok := o["after"]; ok && v != nil {
		s, ok := v.(string)
		if !ok || utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > 4096 {
			return invalid()
		}
		after = s
	}
	out.Set("after", after)
	limit := int64(20)
	maximum := int64(50)
	if search {
		limit = 8
		maximum = 20
	}
	if v, ok := o["limit"]; ok {
		if !finiteInteger(v, 1, maximum) {
			return invalid()
		}
		limit = num(o, "limit")
	}
	out.Set("limit", limit)
	return out, nil
}
