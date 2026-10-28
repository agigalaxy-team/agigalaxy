package configurations

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/selectedtext"
	"math"
	"regexp"
	"strings"
	"time"
)

type Object = map[string]any
type ordered = protocol.OrderedObject

const maxSafe int64 = 9007199254740991

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
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
func text(o Object, k string) string { s, _ := o[k].(string); return s }
func number(o Object, k string) int64 {
	switch v := o[k].(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Float64()
		return int64(n)
	}
	return 0
}
func list(v any) []any { out, _ := v.([]any); return out }
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
func white(r rune) bool {
	return r >= 0x2000 && r <= 0x200a || strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff", r)
}
func safe(v any, max int) bool {
	s, ok := v.(string)
	return ok && protocol.TextLength(s) <= max && strings.TrimFunc(s, white) != "" && selectedtext.Valid(s)
}
func parsePair(v any) (*ordered, bool) {
	o := obj(v)
	if !exact(o, []string{"name", "version"}, nil) || o["name"] != nil && !safe(o["name"], 160) || o["version"] != nil && !safe(o["version"], 80) {
		return nil, false
	}
	return build("name", o["name"], "version", o["version"]), true
}
func parseConditions(v any) (*ordered, bool) {
	o := obj(v)
	if !exact(o, []string{"model", "runtime", "environment", "tools", "skills", "mcp", "promptPolicyVersion", "rulesVersion", "operationScope", "inputScopeSummary", "limitations"}, []string{"contentFingerprint"}) {
		return nil, false
	}
	out := build()
	for _, k := range []string{"model", "runtime", "environment"} {
		p, ok := parsePair(o[k])
		if !ok {
			return nil, false
		}
		out.Set(k, p)
	}
	for _, k := range []string{"tools", "skills", "mcp"} {
		a, ok := o[k].([]any)
		if !ok || len(a) > 32 {
			return nil, false
		}
		items := []any{}
		for _, v := range a {
			c := obj(v)
			if !exact(c, []string{"name", "version"}, []string{"reference"}) || !safe(c["name"], 160) || c["version"] != nil && !safe(c["version"], 80) {
				return nil, false
			}
			item := build("name", c["name"], "version", c["version"])
			if ref, ok := c["reference"]; ok {
				if !safe(ref, 500) {
					return nil, false
				}
				item.Set("reference", ref)
			}
			items = append(items, item)
		}
		out.Set(k, items)
	}
	for _, k := range []string{"promptPolicyVersion", "rulesVersion"} {
		if o[k] != nil && !safe(o[k], 160) {
			return nil, false
		}
		out.Set(k, o[k])
	}
	scope, ok := o["operationScope"].([]any)
	if !ok || len(scope) > 32 {
		return nil, false
	}
	for _, s := range scope {
		if !safe(s, 160) {
			return nil, false
		}
	}
	out.Set("operationScope", scope)
	if o["inputScopeSummary"] != nil && !safe(o["inputScopeSummary"], 1600) {
		return nil, false
	}
	out.Set("inputScopeSummary", o["inputScopeSummary"])
	if hash, ok := o["contentFingerprint"]; ok {
		value, ok := hash.(string)
		if !ok || !hashPattern.MatchString(value) {
			return nil, false
		}
		out.Set("contentFingerprint", hash)
	}
	if !safe(o["limitations"], 1600) {
		return nil, false
	}
	out.Set("limitations", o["limitations"])
	return out, true
}
func parseEvent(payload string) (*ordered, error) {
	invalid := func() (*ordered, error) { return nil, fault.New("invalid_configuration_request", 400) }
	if len(payload) > 24000 {
		return invalid()
	}
	var o Object
	if protocol.Decode([]byte(payload), &o) != nil {
		return invalid()
	}
	base := []string{"schemaVersion", "id", "operationId", "expectedVersion", "actorId", "kind"}
	switch o["kind"] {
	case "record":
		base = append(base, "title", "summary", "conditions", "observedAt", "synthetic", "selectedFieldsOnly")
	case "revoke":
		base = append(base, "reason")
	default:
		return invalid()
	}
	if !exact(o, base, nil) || !integer(o["schemaVersion"], 2, 2) || !uuidPattern.MatchString(text(o, "id")) || !uuidPattern.MatchString(text(o, "operationId")) || !subjectPattern.MatchString(text(o, "actorId")) {
		return invalid()
	}
	out := build("schemaVersion", 2, "id", o["id"], "operationId", o["operationId"], "expectedVersion", o["expectedVersion"], "actorId", o["actorId"], "kind", o["kind"])
	if o["kind"] == "revoke" {
		if !integer(o["expectedVersion"], 1, maxSafe) || !safe(o["reason"], 1600) {
			return invalid()
		}
		out.Set("reason", o["reason"])
		return out, nil
	}
	if !integer(o["expectedVersion"], 0, 1000) || !safe(o["title"], 160) || !safe(o["summary"], 1600) || o["selectedFieldsOnly"] != true {
		return invalid()
	}
	if _, ok := o["synthetic"].(bool); !ok {
		return invalid()
	}
	conditions, ok := parseConditions(o["conditions"])
	if !ok {
		return invalid()
	}
	at := text(o, "observedAt")
	if !isoPattern.MatchString(at) {
		return invalid()
	}
	if _, e := time.Parse(time.RFC3339Nano, at); e != nil {
		return invalid()
	}
	out.Set("title", o["title"])
	out.Set("summary", o["summary"])
	out.Set("conditions", conditions)
	out.Set("observedAt", at)
	out.Set("synthetic", o["synthetic"])
	out.Set("selectedFieldsOnly", true)
	return out, nil
}
func parseRequest(raw []byte, kind string) (Object, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil {
		return nil, fault.New("invalid_configuration_request", 400)
	}
	bad := func() (Object, error) { return nil, fault.New("invalid_configuration_request", 400) }
	switch kind {
	case "read":
		if !exact(o, []string{"id"}, []string{"version"}) || !uuidPattern.MatchString(text(o, "id")) {
			return bad()
		}
		if v, ok := o["version"]; ok && !integer(v, 1, maxSafe) {
			return bad()
		}
	case "query":
		if !exact(o, nil, []string{"subjectId", "after", "limit"}) {
			return bad()
		}
		if v, ok := o["subjectId"]; ok {
			value, ok := v.(string)
			if !ok || !subjectPattern.MatchString(value) {
				return bad()
			}
		}
		if v, ok := o["after"]; ok {
			value, ok := v.(string)
			if !ok || !uuidPattern.MatchString(value) {
				return bad()
			}
		}
	case "versions":
		if !exact(o, []string{"id"}, []string{"afterVersion", "limit"}) || !uuidPattern.MatchString(text(o, "id")) {
			return bad()
		}
		if v, ok := o["afterVersion"]; ok {
			if !integer(v, 0, maxSafe) {
				return bad()
			}
		} else {
			o["afterVersion"] = int64(0)
		}
	case "receipt":
		if !exact(o, []string{"operationId", "payloadHash"}, nil) || !uuidPattern.MatchString(text(o, "operationId")) || !hashPattern.MatchString(text(o, "payloadHash")) {
			return bad()
		}
	}
	if kind == "query" || kind == "versions" {
		if v, ok := o["limit"]; ok {
			if !integer(v, 1, 50) {
				return bad()
			}
		} else {
			o["limit"] = int64(20)
		}
	}
	return o, nil
}
