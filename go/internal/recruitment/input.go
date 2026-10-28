package recruitment

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"regexp"
	"unicode/utf8"
)

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func strict(x Object, keys ...string) bool {
	a := map[string]bool{}
	for _, k := range keys {
		a[k] = true
	}
	for k := range x {
		if !a[k] {
			return false
		}
	}
	return true
}
func integer(v any) (int64, bool) {
	var n float64
	switch x := v.(type) {
	case json.Number:
		n, _ = x.Float64()
	case float64:
		n = x
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	default:
		return 0, false
	}
	return int64(n), !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && n >= 0 && n <= 9007199254740991
}
func trim(s string) string {
	r := []rune(s)
	space := func(c rune) bool {
		return c >= 9 && c <= 13 || c == 32 || c == 0xa0 || c == 0x1680 || c >= 0x2000 && c <= 0x200a || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff
	}
	i, j := 0, len(r)
	for i < j && space(r[i]) {
		i++
	}
	for j > i && space(r[j-1]) {
		j--
	}
	return string(r[i:j])
}
func invalid() error { return fail("invalid_recruitment_request", 400) }
func text(x Object, key string, min, max int, optional bool) error {
	v, exists := x[key]
	if !exists && optional {
		x[key] = ""
		return nil
	}
	s, ok := v.(string)
	s = trim(s)
	n := utf8.RuneCountInString(s)
	if !ok || n < min || n > max {
		return invalid()
	}
	x[key] = s
	return nil
}
func ParseDocument(x Object) (Object, error) {
	if x == nil || !strict(x, "title", "role", "summary", "functions", "technologies", "conditions", "contactSubjectId") {
		return nil, invalid()
	}
	out := Object{}
	for k, v := range x {
		out[k] = v
	}
	for _, f := range []struct {
		k string
		n int
	}{{"title", 120}, {"role", 500}, {"summary", 3000}} {
		if e := text(out, f.k, 1, f.n, false); e != nil {
			return nil, e
		}
	}
	if e := text(out, "conditions", 0, 2000, true); e != nil {
		return nil, e
	}
	if !opportunities.Subject.MatchString(str(out, "contactSubjectId")) {
		return nil, invalid()
	}
	for _, k := range []string{"functions", "technologies"} {
		v, ok := out[k]
		if !ok && k == "technologies" {
			v = []any{}
		}
		tags, e := opportunities.Tags(v, k == "functions")
		if e != nil {
			return nil, invalid()
		}
		out[k] = tags
	}
	return out, nil
}
func ParseEvent(raw []byte) (Object, error) {
	var x Object
	if protocol.Decode(raw, &x) != nil || x == nil {
		return nil, invalid()
	}
	for _, k := range []string{"operationId", "recruitmentId", "projectId"} {
		if !opportunities.UUID.MatchString(str(x, k)) {
			return nil, invalid()
		}
	}
	n, ok := integer(x["expectedRevision"])
	if !ok {
		return nil, invalid()
	}
	x["expectedRevision"] = n
	switch str(x, "kind") {
	case "create", "revise", "renew":
		if !strict(x, "operationId", "recruitmentId", "projectId", "expectedRevision", "kind", "document", "expiresAt") {
			return nil, invalid()
		}
		d, e := ParseDocument(obj(x, "document"))
		if e != nil {
			return nil, e
		}
		x["document"] = d
		n, ok = integer(x["expiresAt"])
		if !ok || n == 0 {
			return nil, invalid()
		}
		x["expiresAt"] = n
	case "pause", "close":
		if !strict(x, "operationId", "recruitmentId", "projectId", "expectedRevision", "kind", "note") {
			return nil, invalid()
		}
		if e := text(x, "note", 0, 1000, true); e != nil {
			return nil, e
		}
	case "link-task":
		if !strict(x, "operationId", "recruitmentId", "projectId", "expectedRevision", "kind", "taskId", "expectedTaskVersion") || !opportunities.UUID.MatchString(str(x, "taskId")) {
			return nil, invalid()
		}
		n, ok = integer(x["expectedTaskVersion"])
		if !ok || n == 0 {
			return nil, invalid()
		}
		x["expectedTaskVersion"] = n
	default:
		return nil, invalid()
	}
	return x, nil
}
func parseQuery(raw []byte) (Object, error) {
	var x Object
	if protocol.Decode(raw, &x) != nil || x == nil || !strict(x, "view", "context", "after", "limit") {
		return nil, invalid()
	}
	if _, ok := x["view"]; !ok {
		x["view"] = "discover"
	}
	if !has([]string{"discover", "managed"}, str(x, "view")) {
		return nil, invalid()
	}
	if c, ok := x["context"]; ok {
		v, _ := c.(map[string]any)
		p, e := opportunities.ParseContext(v)
		if e != nil {
			return nil, invalid()
		}
		x["context"] = p
	} else if str(x, "view") == "discover" {
		return nil, invalid()
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(20)
	}
	n, ok := integer(x["limit"])
	if !ok || n < 1 || n > 20 {
		return nil, invalid()
	}
	x["limit"] = n
	if a := x["after"]; a != nil {
		s, ok := a.(string)
		if !ok || utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > 4096 {
			return nil, invalid()
		}
	}
	return x, nil
}
