package historyv2

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
)

var hiddenOrdinals = map[string]bool{"recordEventIds": true, "caseVersion": true, "expectedVersion": true, "expectedTaskVersion": true, "expectedParticipationVersion": true}

func visible(v any) any {
	if o, ok := v.(*ordered); ok {
		out := build()
		for _, k := range o.Keys() {
			if !hiddenOrdinals[k] {
				out.Set(k, visible(o.Values()[k]))
			}
		}
		return out
	}
	if o, ok := v.(Object); ok {
		out := Object{}
		for k, v := range o {
			if !hiddenOrdinals[k] {
				out[k] = visible(v)
			}
		}
		return out
	}
	if a, ok := v.([]any); ok {
		out := []any{}
		for _, v := range a {
			out = append(out, visible(v))
		}
		return out
	}
	if t, ok := v.(time.Time); ok {
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}
func fingerprintValue(v any, material bool) any {
	if o, ok := v.(*ordered); ok {
		controlled := material || o.Values()["format"] == "task-text-view-v1"
		out := build()
		for _, k := range o.Keys() {
			if !controlled || k != "checkedAt" {
				out.Set(k, fingerprintValue(o.Values()[k], controlled))
			}
		}
		return out
	}
	if o, ok := v.(Object); ok {
		controlled := material || o["format"] == "task-text-view-v1"
		out := Object{}
		for k, v := range o {
			if !controlled || k != "checkedAt" {
				out[k] = fingerprintValue(v, controlled)
			}
		}
		return out
	}
	if a, ok := v.([]any); ok {
		out := []any{}
		for _, v := range a {
			out = append(out, fingerprintValue(v, material))
		}
		return out
	}
	return v
}
func fingerprint(v any) (string, error) {
	raw, e := protocol.EncodeJS(fingerprintValue(visible(v), false))
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
func timestamp(v any) any {
	switch v := v.(type) {
	case nil:
		return nil
	case time.Time:
		return v.UTC().Format("2006-01-02T15:04:05.000Z")
	case int64:
		return time.Unix(v, 0).UTC().Format("2006-01-02T15:04:05.000Z")
	case int:
		return time.Unix(int64(v), 0).UTC().Format("2006-01-02T15:04:05.000Z")
	case float64:
		return time.UnixMilli(int64(v * 1000)).UTC().Format("2006-01-02T15:04:05.000Z")
	case json.Number:
		f, _ := v.Float64()
		return time.UnixMilli(int64(f * 1000)).UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}
func truthy(v any) bool {
	if v == nil {
		return false
	}
	switch v := v.(type) {
	case bool:
		return v
	case string:
		return v != ""
	case int64:
		return v != 0
	case int:
		return v != 0
	case float64:
		return v != 0
	}
	return true
}
func stringsOf(v any) []string {
	out := []string{}
	for _, v := range arr(v) {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
func jsLess(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
func sortedUnique(values []string) []any {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return jsLess(out[i], out[j]) })
	result := []any{}
	for _, v := range out {
		result = append(result, v)
	}
	return result
}
func in(values any, key string) bool {
	for _, v := range arr(values) {
		if v == key {
			return true
		}
	}
	return false
}
func windowMatches(v any, window Object, now int64) bool {
	if window["kind"] == "all-visible" {
		return true
	}
	s, ok := v.(string)
	if !ok {
		return false
	}
	at, ok := millis(s)
	if !ok {
		return false
	}
	before, from := now*1000+1, (now-365*86400)*1000
	if window["kind"] == "custom" {
		before, _ = millis(str(window, "before"))
		from, _ = millis(str(window, "from"))
	} else if window["kind"] == "90-days" {
		from = (now - 90*86400) * 1000
	}
	return at >= from && at < before
}
func relevance(item *ordered, options Object) (*ordered, error) {
	raw, e := protocol.EncodeJS(item)
	if e != nil {
		return nil, e
	}
	text := lower(string(raw))
	terms := strings.FieldsFunc(lower(str(options, "query")), white)
	for _, term := range terms {
		if !strings.Contains(text, term) {
			return nil, nil
		}
	}
	if capability := str(options, "capabilityId"); capability != "" && !in(item.Values()["capabilityIds"], capability) {
		return nil, nil
	}
	reasons := []any{}
	for _, term := range terms {
		reasons = append(reasons, build("kind", "visible-field-text", "term", term))
	}
	if c := str(options, "capabilityId"); c != "" {
		reasons = append(reasons, build("kind", "declared-task-capability", "capabilityId", c, "capabilityVerified", false))
	}
	context := obj(options["context"])
	if id := str(context, "taskId"); id != "" {
		kind := "different-task"
		if in(item.Values()["taskIds"], id) {
			kind = "same-task"
		}
		reasons = append(reasons, build("kind", kind, "taskId", id))
	}
	if env := str(context, "environment"); env != "" {
		environments := []string{}
		for _, v := range arr(item.Values()["attempts"]) {
			environment := obj(v)["environment"]
			s, ok := environment.(string)
			if !ok {
				raw, e := protocol.EncodeJS(environment)
				if e != nil {
					return nil, e
				}
				s = string(raw)
			}
			environments = append(environments, s)
		}
		kind := "environment-unknown"
		if len(environments) > 0 {
			kind = "environment-different-or-unknown"
		}
		for _, value := range environments {
			if strings.Contains(lower(value), lower(env)) {
				kind = "environment-field-match"
				break
			}
		}
		reasons = append(reasons, build("kind", kind, "requestedEnvironment", env, "environmentCompatibilityVerified", false))
	}
	out := build()
	for _, k := range item.Keys() {
		out.Set(k, item.Values()[k])
	}
	out.Set("matchReasons", reasons)
	out.Set("ranking", "stable-source-id; no-capability-ranking")
	return out, nil
}
