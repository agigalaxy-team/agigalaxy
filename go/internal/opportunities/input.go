package opportunities

import (
	"encoding/json"
	"regexp"
	"unicode/utf8"
)

var UUID = regexp.MustCompile(`(?i)^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var Subject = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)

func trim(s string) string {
	r := []rune(s)
	space := func(r rune) bool {
		return r >= 9 && r <= 13 || r == 32 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	}
	first, last := 0, len(r)
	for first < last && space(r[first]) {
		first++
	}
	for last > first && space(r[last-1]) {
		last--
	}
	return string(r[first:last])
}
func exact(x Object, keys ...string) bool {
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range x {
		if !allowed[key] {
			return false
		}
	}
	return true
}
func invalid() error { return fail("invalid_discovery_v2_query", 409) }
func Tags(v any, required bool) ([]any, error) {
	values, ok := v.([]any)
	if !ok || len(values) > 16 || required && len(values) == 0 {
		return nil, invalid()
	}
	out := []any{}
	for _, v := range values {
		s, ok := v.(string)
		s = trim(s)
		if !ok || s == "" || utf8.RuneCountInString(s) > 80 {
			return nil, invalid()
		}
		out = append(out, s)
	}
	return out, nil
}
func ParseContext(input Object) (Object, error) {
	x := Object{}
	for k, v := range input {
		x[k] = v
	}
	if str(x, "kind") == "project" {
		if !exact(x, "kind", "projectId") || !UUID.MatchString(str(x, "projectId")) {
			return nil, invalid()
		}
		return x, nil
	}
	if str(x, "kind") != "ephemeral" || !exact(x, "kind", "title", "functions", "technologies") {
		return nil, invalid()
	}
	title, ok := x["title"].(string)
	title = trim(title)
	if !ok || title == "" || utf8.RuneCountInString(title) > 120 {
		return nil, invalid()
	}
	x["title"] = title
	tags, e := Tags(x["functions"], true)
	if e != nil {
		return nil, e
	}
	x["functions"] = tags
	if _, ok := x["technologies"]; !ok {
		x["technologies"] = []any{}
	}
	tags, e = Tags(x["technologies"], false)
	if e != nil {
		return nil, e
	}
	x["technologies"] = tags
	return x, nil
}
func ParseRef(input Object) (Object, error) {
	if input == nil || !Subject.MatchString(str(input, "subjectId")) || !UUID.MatchString(str(input, "projectId")) {
		return nil, invalid()
	}
	keys := []string{"subjectId", "projectId", "statementId"}
	ids := []string{"statementId"}
	switch str(input, "sourceKind") {
	case "":
	case "project":
		keys = []string{"sourceKind", "subjectId", "projectId", "documentEventId", "policyEventId"}
		ids = []string{"documentEventId", "policyEventId"}
	case "recruitment":
		keys = []string{"sourceKind", "subjectId", "projectId", "recruitmentId", "eventId"}
		ids = []string{"recruitmentId", "eventId"}
	default:
		return nil, invalid()
	}
	if !exact(input, keys...) {
		return nil, invalid()
	}
	for _, key := range ids {
		if !UUID.MatchString(str(input, key)) {
			return nil, invalid()
		}
	}
	return input, nil
}
func SameRef(a, b Object) bool {
	if a["subjectId"] != b["subjectId"] || a["projectId"] != b["projectId"] || a["sourceKind"] != b["sourceKind"] {
		return false
	}
	switch str(a, "sourceKind") {
	case "recruitment":
		return a["recruitmentId"] == b["recruitmentId"] && a["eventId"] == b["eventId"]
	case "project":
		return a["documentEventId"] == b["documentEventId"] && a["policyEventId"] == b["policyEventId"]
	}
	return a["statementId"] == b["statementId"]
}
func number(v any) int64 {
	switch n := v.(type) {
	case int:
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
