// Package trustpackages preserves exact authored-record reproduction licenses.
// Source reading, portable copying and current service access remain separate.
package trustpackages

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"math"
	"regexp"
)

type Object = map[string]any

func fail(c string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(c, n)
}
func object(v any) Object           { o, _ := v.(map[string]any); return o }
func str(o Object, k string) string { s, _ := o[k].(string); return s }
func array(v any) []any             { a, _ := v.([]any); return a }
func number(v any) int64 {
	switch v := v.(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	}
	return 0
}
func integer(v any, min float64) bool {
	var n float64
	switch v := v.(type) {
	case float64:
		n = v
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	default:
		return false
	}
	return n >= min && n <= 9007199254740991 && !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n
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

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func origin(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	u, e := whatwg.Parse(s)
	return e == nil && u.Scheme() == "https" && u.Host() != "" && "https://"+u.Host() == s
}
func sourceRef(v any) bool {
	o := object(v)
	if !exact(o, []string{"endpoint", "kind", "id", "version"}, []string{"caseId", "taskId"}) || !origin(o["endpoint"]) || !uuidPattern.MatchString(str(o, "id")) || !integer(o["version"], 1) {
		return false
	}
	switch str(o, "kind") {
	case "case-event", "evidence", "verification", "proof", "ci-proof-v2":
	default:
		return false
	}
	for _, k := range []string{"caseId", "taskId"} {
		if _, ok := o[k]; ok && !uuidPattern.MatchString(str(o, k)) {
			return false
		}
	}
	return true
}
func audience(v any) bool {
	o := object(v)
	if o["kind"] == "public" {
		return exact(o, []string{"kind"}, nil)
	}
	if !exact(o, []string{"kind", "subjectIds"}, nil) || o["kind"] != "subjects" {
		return false
	}
	a, ok := o["subjectIds"].([]any)
	if !ok || len(a) < 1 || len(a) > 100 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range a {
		s, _ := v.(string)
		if !subjectPattern.MatchString(s) || seen[s] {
			return false
		}
		seen[s] = true
	}
	return true
}
func ParsePermission(o Object) (Object, error) {
	bad := func() (Object, error) { return nil, fail("invalid_trust_input", 422) }
	if !exact(o, []string{"version", "type", "id", "operationId", "subjectId", "bindingId", "endpoint", "kind", "grantee", "source", "sourceHash", "originalSignatureHash", "audience", "purpose", "permission", "trainingAllowed", "onlineAccessGranted", "sourceAuthorDeclaration", "keyId", "epoch", "chainHead", "issuedAt", "expiresAt"}, nil) || !integer(o["version"], 1) || number(o["version"]) != 1 || o["type"] != "galaxy-trust-source-permission" || (o["kind"] != "grant" && o["kind"] != "revoke") || !subjectPattern.MatchString(str(o, "subjectId")) || !subjectPattern.MatchString(str(o, "grantee")) || !origin(o["endpoint"]) || !sourceRef(o["source"]) || !audience(o["audience"]) || o["purpose"] != "trust-package-only" || o["permission"] != "copy-exact-authored-record" || o["trainingAllowed"] != false || o["onlineAccessGranted"] != false || o["sourceAuthorDeclaration"] != "I authorize the exact authored record; no third-party source bodies are included" || !integer(o["epoch"], 0) || !integer(o["issuedAt"], 0) || !integer(o["expiresAt"], 0) || number(o["expiresAt"]) <= number(o["issuedAt"]) || number(o["expiresAt"])-number(o["issuedAt"]) > 30*86400 {
		return bad()
	}
	for _, k := range []string{"id", "operationId", "bindingId"} {
		if !uuidPattern.MatchString(str(o, k)) {
			return bad()
		}
	}
	for _, k := range []string{"sourceHash", "keyId"} {
		if !hashPattern.MatchString(str(o, k)) {
			return bad()
		}
	}
	for _, k := range []string{"originalSignatureHash", "chainHead"} {
		if o[k] != nil && !hashPattern.MatchString(str(o, k)) {
			return bad()
		}
	}
	return o, nil
}
func Parse(action string, in Object) (Object, error) {
	bad := func() (Object, error) { return nil, fail("invalid_trust_input", 422) }
	out := Object{}
	for k, v := range in {
		out[k] = v
	}
	switch action {
	case "preview":
		if !exact(in, []string{"id", "operationId", "source", "grantee", "audience", "expiresAt"}, nil) || !uuidPattern.MatchString(str(in, "id")) || !uuidPattern.MatchString(str(in, "operationId")) || !sourceRef(in["source"]) || !subjectPattern.MatchString(str(in, "grantee")) || !audience(in["audience"]) || !integer(in["expiresAt"], 0) {
			return bad()
		}
	case "revoke-preview":
		if !exact(in, []string{"id", "operationId"}, nil) || !uuidPattern.MatchString(str(in, "id")) || !uuidPattern.MatchString(str(in, "operationId")) {
			return bad()
		}
	case "submit":
		if !exact(in, []string{"signed"}, nil) {
			return bad()
		}
		signed, ok := in["signed"].(string)
		if !ok || jstext.From(signed).CodePointLen() > 30000 {
			return bad()
		}
	case "receipt", "status":
		if !exact(in, []string{"id"}, nil) || !uuidPattern.MatchString(str(in, "id")) {
			return bad()
		}
	case "query":
		if !exact(in, nil, []string{"after", "role"}) {
			return bad()
		}
		if v, ok := in["after"]; ok {
			if v != nil && !uuidPattern.MatchString(str(in, "after")) {
				return bad()
			}
		} else {
			out["after"] = nil
		}
		if v, ok := in["role"]; ok {
			if v != "author" && v != "grantee" {
				return bad()
			}
		} else {
			out["role"] = "author"
		}
	case "sources":
		if !exact(in, []string{"selections", "audience", "expiresAt"}, nil) || !audience(in["audience"]) || !integer(in["expiresAt"], 1) {
			return bad()
		}
		selections, ok := in["selections"].([]any)
		if !ok || len(selections) > 50 {
			return bad()
		}
		for _, v := range selections {
			s := object(v)
			if !exact(s, []string{"ref", "mode"}, []string{"permissionId"}) || !sourceRef(s["ref"]) || (s["mode"] != "reference" && s["mode"] != "copy") {
				return bad()
			}
			if _, ok := s["permissionId"]; ok && !uuidPattern.MatchString(str(s, "permissionId")) {
				return bad()
			}
		}
	default:
		return bad()
	}
	return out, nil
}

// The shared canonicalizer accepts an object root. The original trust helper
// also canonicalizes scalar field values for exact scope comparisons.
func canonical(v any) (string, error) {
	b, e := identity.Canonical(Object{"value": v})
	if e != nil {
		return "", e
	}
	return string(b[len(`{"value":`) : len(b)-1]), nil
}
func same(a, b any) bool {
	x, e := canonical(a)
	if e != nil {
		return false
	}
	y, e := canonical(b)
	return e == nil && x == y
}
func audienceAllows(grant, requested Object) bool {
	if grant["kind"] == "public" {
		return true
	}
	if requested["kind"] != "subjects" {
		return false
	}
	for _, v := range array(requested["subjectIds"]) {
		found := false
		for _, g := range array(grant["subjectIds"]) {
			if g == v {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func decodeObject(raw []byte) (Object, error) {
	v, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, e
	}
	o := object(v)
	if o == nil {
		return nil, fail("invalid_trust_input", 422)
	}
	return o, nil
}
func wireString(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case jstext.String:
		return v.Decoded()
	}
	return ""
}
func boundedText(v any, min, max int) bool {
	var value jstext.String
	switch v := v.(type) {
	case string:
		value = jstext.From(v)
	case jstext.String:
		value = v
	default:
		return false
	}
	n := value.CodePointLen()
	return n >= min && n <= max
}
