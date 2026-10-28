package builders

import (
	"encoding/json"
	"strings"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/jsonschema-go/jsonschema"
	whatwg "github.com/nlnwa/whatwg-url/url"
)

func schemas() Object {
	var v, extra Object
	_ = protocol.Decode([]byte(contractsJSON), &v)
	_ = protocol.Decode([]byte(portableContractsJSON), &extra)
	for key, value := range extra {
		v[key] = value
	}
	return v
}
func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r == '\ufeff' || r == '\u000b' || r == '\u000c' || r == '\u0009' || r == '\u000a' || r == '\u000d' || r == '\u2028' || r == '\u2029' || unicode.Is(unicode.Zs, r)
	})
}
func selectedSchema(schema, value Object) Object {
	for _, union := range []string{"oneOf", "anyOf"} {
		for _, raw := range arr(schema[union]) {
			branch := obj(raw)
			for _, key := range []string{"kind", "type", "action"} {
				p := obj(obj(branch["properties"])[key])
				if constant, ok := p["const"]; ok && value[key] == constant {
					return branch
				}
			}
		}
		for _, raw := range arr(schema[union]) {
			branch := obj(raw)
			if branch["type"] == "object" {
				return branch
			}
		}
	}
	return schema
}
func normalize(schema Object, value any) any {
	if v, ok := value.(Object); ok {
		schema = selectedSchema(schema, v)
		for key, raw := range obj(schema["properties"]) {
			p := obj(raw)
			child, present := v[key]
			if !present {
				if d, ok := p["default"]; ok {
					v[key] = d
					child = d
					present = true
				}
			}
			if present {
				v[key] = normalize(p, child)
			}
		}
		return v
	}
	if values, ok := value.([]any); ok {
		for i, v := range values {
			values[i] = normalize(obj(schema["items"]), v)
		}
		return values
	}
	if s, ok := value.(string); ok {
		if schema["minLength"] != nil && schema["format"] == nil && schema["pattern"] == nil && schema["enum"] == nil && schema["const"] == nil {
			return trim(s)
		}
	}
	return value
}
func parse(name string, raw []byte) (Object, error) {
	schema := obj(schemas()[name])
	var value any
	if schema == nil || protocol.Decode(raw, &value) != nil {
		return nil, fault.New("invalid_builder_query", 400)
	}
	value = normalize(schema, value)
	if o := obj(value); o != nil {
		if name == "builderQuerySchema" {
			if q, ok := o["query"].(string); ok {
				o["query"] = trim(q)
			}
		}
	}
	wire, _ := protocol.Encode(schema)
	var spec jsonschema.Schema
	if json.Unmarshal(wire, &spec) != nil {
		return nil, fault.New("invalid_builder_query", 400)
	}
	resolved, e := spec.Resolve(nil)
	if e != nil {
		return nil, e
	}
	wire, _ = protocol.Encode(value)
	var decoded any
	if json.Unmarshal(wire, &decoded) != nil || resolved.Validate(&decoded) != nil || !refsValid(schema, value) || !refinements(value) {
		return nil, fault.New("invalid_builder_query", 400)
	}
	return obj(value), nil
}
func refsValid(schema Object, value any) bool {
	if o := obj(value); o != nil {
		schema = selectedSchema(schema, o)
		for key, v := range o {
			if !refsValid(obj(obj(schema["properties"])[key]), v) {
				return false
			}
		}
	}
	if values, ok := value.([]any); ok {
		for _, v := range values {
			if !refsValid(obj(schema["items"]), v) {
				return false
			}
		}
	}
	if s, ok := value.(string); ok && schema["format"] == "uri" {
		u, e := whatwg.Parse(s)
		if e != nil || u.Scheme() != "https" || u.Username() != "" || u.Password() != "" || u.Search() != "" || u.Hash() != "" {
			return false
		}
	}
	return true
}
func unique(values []any, key func(any) string) bool {
	seen := map[string]bool{}
	for _, v := range values {
		k := key(v)
		if seen[k] {
			return false
		}
		seen[k] = true
	}
	return true
}
func refinements(value any) bool {
	if o := obj(value); o != nil {
		for _, key := range []string{"proofIds", "objectActions", "missingCapabilities"} {
			if values, ok := o[key].([]any); ok && !unique(values, func(v any) string { s, _ := v.(string); return s }) {
				return false
			}
		}
		for _, key := range []string{"evidenceRefs", "verificationRefs"} {
			if values, ok := o[key].([]any); ok && !unique(values, func(v any) string { b, _ := protocol.Encode(v); return string(b) }) {
				return false
			}
		}
		if o["profile"] == "galaxy-builder-support/2" {
			for _, v := range arr(o["objectActions"]) {
				for _, missing := range arr(o["missingCapabilities"]) {
					if v == missing {
						return false
					}
				}
			}
			if len(arr(o["objectActions"])) == 0 {
				return false
			}
		}
		if o["kind"] == "scope-report" && !unique(arr(o["checks"]), func(v any) string { return txt(obj(v), "action") }) {
			return false
		}
		if o["kind"] == "compatibility" {
			required := []string{"ids", "schema", "signatures", "import", "privacy", "revocation"}
			if o["profile"] != nil {
				required = []string{"ids", "evidence", "signatures", "schema", "import", "privacy", "revocation"}
			} else if o["execution"] != nil {
				return false
			}
			checks := arr(o["checks"])
			if len(checks) != len(required) || !unique(checks, func(v any) string { return txt(obj(v), "id") }) {
				return false
			}
			for _, key := range required {
				found := false
				for _, v := range checks {
					found = found || obj(v)["id"] == key
				}
				if !found {
					return false
				}
			}
		}
		for _, v := range o {
			if !refinements(v) {
				return false
			}
		}
	}
	if values, ok := value.([]any); ok {
		for _, v := range values {
			if !refinements(v) {
				return false
			}
		}
	}
	return true
}
func parsePayload(name string, input Object, max int) (Object, error) {
	payload, ok := input["payloadJson"].(string)
	if !ok || len([]byte(payload)) > max {
		return nil, fault.New("invalid_builder_payload", 400)
	}
	return parse(name, []byte(payload))
}
