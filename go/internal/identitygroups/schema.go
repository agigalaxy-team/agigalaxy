package identitygroups

import (
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/jsonschema-go/jsonschema"
	whatwg "github.com/nlnwa/whatwg-url/url"
)

func factsKey(v Object) string {
	return fmt.Sprintf("%s:%s:%d", txt(v, "kind"), txt(v, "id"), num(v, "version"))
}
func canonicalEqual(a, b any) bool {
	x, e := identity.Canonical(a)
	if e != nil {
		return false
	}
	y, e := identity.Canonical(b)
	return e == nil && string(x) == string(y)
}
func parse(name string, raw []byte) (Object, error) {
	bad := fault.New("invalid_identity_group", 400)
	var contracts Object
	_ = protocol.Decode([]byte(contractsJSON), &contracts)
	schema := obj(contracts[name])
	if schema == nil {
		return nil, bad
	}
	value, e := jstext.DecodeJSON(raw)
	if e != nil || obj(value) == nil {
		return nil, bad
	}
	v := obj(value)
	for key, p := range obj(schema["properties"]) {
		if _, ok := v[key]; !ok {
			if d, ok := obj(p)["default"]; ok {
				v[key] = d
			}
		}
	}
	encoded, e := protocol.Encode(schema)
	if e != nil {
		return nil, e
	}
	var spec jsonschema.Schema
	if json.Unmarshal(encoded, &spec) != nil {
		return nil, bad
	}
	resolved, e := spec.Resolve(nil)
	if e != nil {
		return nil, e
	}
	encoded, e = protocol.Encode(v)
	if e != nil {
		return nil, bad
	}
	var decoded any
	if json.Unmarshal(encoded, &decoded) != nil || resolved.Validate(&decoded) != nil {
		return nil, bad
	}
	if name == "identityGroupIntentSchema" {
		endpoint := txt(v, "endpoint")
		u, e := whatwg.Parse(endpoint)
		if e != nil || u.Scheme() != "https" || u.Username() != "" || u.Password() != "" || u.Href(false) != endpoint+"/" {
			return nil, bad
		}
		if num(v, "expiresAt") <= num(v, "issuedAt") || num(v, "expiresAt") > num(v, "issuedAt")+86400 {
			return nil, bad
		}
		if v["kind"] != "revoke" {
			members := arr(v["memberIds"])
			if len(members) < 2 || len(members) > 8 || !has(members, v["canonicalDisplayId"]) {
				return nil, bad
			}
			for _, key := range []string{"memberIds", "viewers"} {
				seen := map[string]bool{}
				for _, id := range arr(v[key]) {
					s, _ := id.(string)
					if seen[s] {
						return nil, bad
					}
					seen[s] = true
				}
			}
			sources := map[string]bool{}
			for _, r := range arr(v["sourceRefs"]) {
				ref := obj(r)
				if !has(members, ref["originalSubjectId"]) || sources[factsKey(ref)] {
					return nil, bad
				}
				sources[factsKey(ref)] = true
			}
			corrected := map[string]bool{}
			for _, r := range arr(v["attributionCorrections"]) {
				c := obj(r)
				ref := obj(c["source"])
				if !has(members, c["displaySubjectId"]) || corrected[factsKey(ref)] {
					return nil, bad
				}
				found := false
				for _, source := range arr(v["sourceRefs"]) {
					found = found || canonicalEqual(source, ref)
				}
				if !found {
					return nil, bad
				}
				corrected[factsKey(ref)] = true
			}
		}
	}
	return v, nil
}

// Pure original schemas are also used by the owning Native client; raw signed
// payloadJson/proofJson strings are retained separately and never re-encoded.
func ParseIntent(raw []byte) (Object, error) { return parse("identityGroupIntentSchema", raw) }
func ParseProof(raw []byte) (Object, error)  { return parse("identityGroupProofSchema", raw) }
func ParseSourceSelection(raw []byte) (Object, error) {
	return parse("identityGroupSourceSelectionSchema", raw)
}
