package projects

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"net/url"
	"sort"
	"strconv"
	"unicode/utf8"
)

func strict(o Object, keys ...string) bool {
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range o {
		if !allowed[key] {
			return false
		}
	}
	return true
}
func trim(s string) string {
	points := []rune(s)
	whitespace := func(r rune) bool {
		return r >= 9 && r <= 13 || r == 32 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	}
	first, last := 0, len(points)
	for first < last && whitespace(points[first]) {
		first++
	}
	for last > first && whitespace(points[last-1]) {
		last--
	}
	return string(points[first:last])
}
func integer(v any, min, max int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= max
	case int64:
		return n >= min && n <= max
	case float64:
		return n == math.Trunc(n) && n >= float64(min) && n <= float64(max)
	case json.Number:
		f, e := n.Float64()
		return e == nil && f == math.Trunc(f) && f >= float64(min) && f <= float64(max)
	}
	return false
}
func projectError() error { return fail("invalid_project_request", 400) }
func tags(v any, nonempty bool) ([]any, bool) {
	values, ok := v.([]any)
	if !ok || len(values) > 16 || nonempty && len(values) == 0 {
		return nil, false
	}
	out := []any{}
	for _, v := range values {
		s, ok := v.(string)
		s = trim(s)
		if !ok || s == "" || utf8.RuneCountInString(s) > 80 {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}
func ParseDocument(input Object, patch bool) (Object, error) {
	if input == nil {
		return nil, projectError()
	}
	out := Object{}
	for key, v := range input {
		if protocol.TextLength(key) > 120 || key == "@policy" {
			return nil, projectError()
		}
		out[key] = v
	}
	if patch && len(out) == 0 {
		return nil, projectError()
	}
	for _, key := range []string{"kind", "title", "summary", "functions", "technologies", "sourceUrl", "discoverable", "participantKind"} {
		value, present := out[key]
		if !present {
			if patch || key == "sourceUrl" {
				continue
			}
			switch key {
			case "technologies":
				out[key] = []any{}
			case "discoverable":
				out[key] = false
			case "participantKind":
				out[key] = "unknown"
			default:
				return nil, projectError()
			}
			continue
		}
		switch key {
		case "kind":
			if !contains([]string{"project", "module"}, str(out, key)) {
				return nil, projectError()
			}
		case "title", "summary":
			s, ok := value.(string)
			s = trim(s)
			max := 120
			if key == "summary" {
				max = 2000
			}
			if !ok || s == "" || utf8.RuneCountInString(s) > max {
				return nil, projectError()
			}
			out[key] = s
		case "functions", "technologies":
			parsed, ok := tags(value, key == "functions")
			if !ok {
				return nil, projectError()
			}
			out[key] = parsed
		case "sourceUrl":
			if value == nil && patch {
				continue
			}
			s, ok := value.(string)
			u, e := url.Parse(s)
			if !ok || utf8.RuneCountInString(s) > 2048 || e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
				return nil, projectError()
			}
		case "discoverable":
			if _, ok := value.(bool); !ok {
				return nil, projectError()
			}
		case "participantKind":
			if !contains([]string{"human", "agent", "team", "tool", "organization", "service", "unknown"}, str(out, key)) {
				return nil, projectError()
			}
		}
	}
	return out, nil
}
func ParseEvent(raw []byte) (Object, error) {
	var x Object
	if protocol.Decode(raw, &x) != nil || x == nil || !uuidPattern.MatchString(str(x, "operationId")) || !uuidPattern.MatchString(str(x, "projectId")) || !integer(x["expectedRevision"], 0, 9007199254740991) {
		return nil, projectError()
	}
	keys := []string{"operationId", "projectId", "expectedRevision", "kind"}
	switch str(x, "kind") {
	case "create":
		keys = append(keys, "document", "sourceStatementId")
		document, e := ParseDocument(obj(x, "document"), false)
		if e != nil {
			return nil, e
		}
		x["document"] = document
		if v, ok := x["sourceStatementId"]; ok {
			value, ok := v.(string)
			if !ok || !uuidPattern.MatchString(value) {
				return nil, projectError()
			}
		}
	case "revise":
		keys = append(keys, "patch")
		patch, e := ParseDocument(obj(x, "patch"), true)
		if e != nil {
			return nil, e
		}
		x["patch"] = patch
	case "grant-role", "revoke-role":
		keys = append(keys, "subjectId", "role")
		if !subjectPattern.MatchString(str(x, "subjectId")) || !contains([]string{"editor", "representative"}, str(x, "role")) {
			return nil, projectError()
		}
	case "offer-transfer":
		keys = append(keys, "transferId", "toSubjectId")
		if !uuidPattern.MatchString(str(x, "transferId")) || !subjectPattern.MatchString(str(x, "toSubjectId")) {
			return nil, projectError()
		}
	case "accept-transfer", "cancel-transfer":
		keys = append(keys, "transferId")
		if !uuidPattern.MatchString(str(x, "transferId")) {
			return nil, projectError()
		}
	case "archive", "restore":
	default:
		return nil, projectError()
	}
	if !strict(x, keys...) {
		return nil, projectError()
	}
	return x, nil
}
func orderedKeys(raw []byte, create bool) []string {
	var x map[string]json.RawMessage
	_ = json.Unmarshal(raw, &x)
	field := "patch"
	if create {
		field = "document"
	}
	decoder := json.NewDecoder(bytes.NewReader(x[field]))
	_, _ = decoder.Token()
	rawKeys := []string{}
	seen := map[string]bool{}
	for decoder.More() {
		token, e := decoder.Token()
		if e != nil {
			break
		}
		key, _ := token.(string)
		if !seen[key] {
			rawKeys = append(rawKeys, key)
			seen[key] = true
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			break
		}
	}
	keys := []string{"kind", "title", "summary", "functions", "technologies", "sourceUrl", "discoverable", "participantKind"}
	for _, key := range rawKeys {
		if !contains(keys, key) {
			keys = append(keys, key)
		}
	}
	indexes := []string{}
	others := []string{}
	for _, key := range keys {
		n, e := strconv.ParseUint(key, 10, 32)
		if e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == key {
			indexes = append(indexes, key)
		} else {
			others = append(others, key)
		}
	}
	sort.Slice(indexes, func(i, j int) bool {
		a, _ := strconv.ParseUint(indexes[i], 10, 32)
		b, _ := strconv.ParseUint(indexes[j], 10, 32)
		return a < b
	})
	return append(indexes, others...)
}
