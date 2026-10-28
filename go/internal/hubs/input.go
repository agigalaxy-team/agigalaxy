package hubs

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/jsonschema-go/jsonschema"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"strings"
	"unicode"
)

func pick(schema Object, value Object) Object {
	for _, union := range []string{"oneOf", "anyOf"} {
		for _, b := range arr(schema[union]) {
			branch := obj(b)
			for _, key := range []string{"kind", "action", "type"} {
				p := obj(obj(branch["properties"])[key])
				if c, ok := p["const"]; ok && c == value[key] || has(arr(p["enum"]), value[key]) {
					return branch
				}
			}
		}
	}
	return schema
}
func normalize(schema Object, value any) any {
	if o := obj(value); o != nil {
		schema = pick(schema, o)
		for key, p := range obj(schema["properties"]) {
			prop := obj(p)
			v, present := o[key]
			if !present {
				if d, ok := prop["default"]; ok {
					o[key] = d
					v = d
					present = true
				}
			}
			if present {
				o[key] = normalize(prop, v)
			}
		}
		return o
	}
	if list, ok := value.([]any); ok {
		for i, v := range list {
			list[i] = normalize(obj(schema["items"]), v)
		}
		return list
	}
	if s, ok := value.(string); ok && schema["minLength"] != nil && schema["format"] == nil && schema["pattern"] == nil && schema["const"] == nil && schema["enum"] == nil {
		return strings.TrimFunc(s, func(r rune) bool {
			return r == '\ufeff' || r == '\u000b' || r == '\u000c' || r == '\u0009' || r == '\u000a' || r == '\u000d' || r == '\u2028' || r == '\u2029' || unicode.Is(unicode.Zs, r)
		})
	}
	return value
}
func parse(name string, raw []byte) (Object, error) {
	bad := fault.New("invalid_hub_request", 400)
	var contracts, value Object
	if protocol.Decode([]byte(contractsJSON), &contracts) != nil || protocol.Decode(raw, &value) != nil || value == nil {
		return nil, bad
	}
	var peer Object
	_ = protocol.Decode([]byte(peeringContractsJSON), &peer)
	for key, schema := range peer {
		contracts[key] = schema
	}
	schema := obj(contracts[name])
	if schema == nil {
		return nil, bad
	}
	value = obj(normalize(schema, value))
	wire, _ := protocol.Encode(schema)
	var spec jsonschema.Schema
	if json.Unmarshal(wire, &spec) != nil {
		return nil, bad
	}
	resolved, e := spec.Resolve(nil)
	if e != nil {
		return nil, e
	}
	wire, _ = protocol.Encode(value)
	var decoded any
	_ = json.Unmarshal(wire, &decoded)
	if resolved.Validate(&decoded) != nil {
		return nil, bad
	}
	var refine func(any) bool
	refine = func(v any) bool {
		if o := obj(v); o != nil {
			if o["status"] == "reported-tested" && o["reportRef"] == nil {
				return false
			}
			for key, x := range o {
				if key == "endpoint" || key == "origin" || key == "destination" {
					if address, ok := x.(string); ok {
						u, e := whatwg.Parse(address)
						if e != nil || u.Scheme() != "https" || u.Username() != "" || u.Password() != "" || u.Href(false) != address+"/" {
							return false
						}
					}
				}
				if key == "scopes" || key == "acceptedScopes" || key == "offeredScopes" || key == "sourceKinds" || key == "requesterIds" || key == "fields" {
					seen := map[any]bool{}
					for _, id := range arr(x) {
						if seen[id] {
							return false
						}
						seen[id] = true
					}
				}
				if key == "fields" && o["kind"] == "contribution-summary" && (!has(arr(x), "eventType") || !has(arr(x), "actorId")) {
					return false
				}
				if key == "parties" {
					p := arr(x)
					if len(p) == 2 && txt(obj(p[0]), "endpoint") >= txt(obj(p[1]), "endpoint") {
						return false
					}
				}
				if !refine(x) {
					return false
				}
			}
		}
		for _, x := range arr(v) {
			if !refine(x) {
				return false
			}
		}
		return true
	}
	if !refine(value) {
		return nil, bad
	}
	if name == "peeringSourcesSchema" && (value["kind"] == "ci-proof-v2" && value["parentId"] != nil || value["kind"] != "ci-proof-v2" && value["parentId"] == nil) {
		return nil, bad
	}
	return value, nil
}
