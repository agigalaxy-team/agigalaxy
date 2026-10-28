package verificationrecords

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Object = map[string]any

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func obj(v any) Object {
	switch v := v.(type) {
	case Object:
		return v
	case *protocol.OrderedObject:
		return v.Values()
	}
	return nil
}
func str(o Object, k string) string { v, _ := o[k].(string); return v }
func num(o Object, k string) int64 {
	switch v := o[k].(type) {
	case int64:
		return v
	case int32:
		return int64(v)
	case int:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		n, e := v.Int64()
		if e == nil {
			return n
		}
		f, _ := v.Float64()
		return int64(f)
	}
	return 0
}
func arr(v any) []any { v1, _ := v.([]any); return v1 }
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
func one(v any, values ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, x := range values {
		if s == x {
			return true
		}
	}
	return false
}
func safe(o Object, k string, min, max int64) bool {
	var n float64
	switch x := o[k].(type) {
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case float64:
		n = x
	case json.Number:
		var e error
		n, e = x.Float64()
		if e != nil {
			return false
		}
	default:
		return false
	}
	return !math.IsInf(n, 0) && math.Trunc(n) == n && n >= float64(min) && n <= float64(max)
}
func text(o Object, k string, min, max int, trim bool) bool {
	s, ok := o[k].(string)
	if !ok {
		return false
	}
	if trim {
		s = strings.TrimFunc(s, func(r rune) bool {
			return r >= 0x2000 && r <= 0x200a || strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff", r)
		})
		o[k] = s
	}
	return protocol.TextLength(s) >= min && protocol.TextLength(s) <= max
}
func date(o Object, k string) bool {
	s, ok := o[k].(string)
	if !ok || !strings.HasSuffix(s, "Z") {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, s)
	return e == nil
}
func reference(v any, typed bool) bool {
	o := obj(v)
	keys := []string{"id", "version"}
	if typed {
		keys = append(keys, "type")
	}
	return exact(o, keys, nil) && uuidPattern.MatchString(str(o, "id")) && safe(o, "version", 1, 9007199254740991) && (!typed || one(o["type"], "attempt", "intervention", "result"))
}
func encode(v any) []byte { raw, _ := protocol.EncodeJS(v); return raw }
func copyObject(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func parseRecord(payload string) (Object, error) {
	invalid := func() (Object, error) { return nil, fault.New("invalid_verification_record", 400) }
	var o Object
	if len(payload) > 24000 || protocol.Decode([]byte(payload), &o) != nil {
		return invalid()
	}
	kind := str(o, "kind")
	required := []string{"kind", "id", "operationId", "expectedVersion", "caseId", "reportedBy", "synthetic"}
	optional := []string{"taskId", "participationId", "participationScopeVersion", "reason"}
	switch kind {
	case "evidence":
		required = append(required, "evidenceType", "source", "observedAt", "reportedSourceState", "summary")
		optional = append(optional, "expiresAt")
	case "verification":
		required = append(required, "target", "scopeVersion", "method", "scope", "conditions", "observation", "summary", "evidenceRefs", "relationship", "observedAt")
		optional = append(optional, "expiresAt")
	case "revoke":
		required = append(required, "objectType", "reason")
	default:
		return invalid()
	}
	if !exact(o, required, optional) {
		return invalid()
	}
	for _, k := range []string{"id", "operationId", "caseId"} {
		if !uuidPattern.MatchString(str(o, k)) {
			return invalid()
		}
	}
	if !safe(o, "expectedVersion", 0, 999) || !subjectPattern.MatchString(str(o, "reportedBy")) {
		return invalid()
	}
	if _, ok := o["synthetic"].(bool); !ok {
		return invalid()
	}
	for _, k := range []string{"taskId", "participationId"} {
		if v, ok := o[k]; ok && v != nil && !uuidPattern.MatchString(str(o, k)) {
			return invalid()
		}
	}
	if _, ok := o["participationScopeVersion"]; ok && !safe(o, "participationScopeVersion", 1, 9007199254740991) {
		return invalid()
	}
	for _, k := range []string{"reason", "summary", "scope"} {
		if _, ok := o[k]; ok && !text(o, k, 1, 4000, true) {
			return invalid()
		}
	}
	if kind != "revoke" && !date(o, "observedAt") {
		return invalid()
	}
	if v, present := o["expiresAt"]; present && v != nil && !date(o, "expiresAt") {
		return invalid()
	}
	switch kind {
	case "evidence":
		if !one(o["evidenceType"], "self-assertion", "counterparty-confirmation", "git-commit", "pull-request", "issue", "ci-result", "test-result", "build-result", "artifact-hash", "signed-statement", "organization-record", "credential", "external-platform-record", "production-metric", "payment-proof", "capsule-reuse") || !one(o["reportedSourceState"], "available", "unreachable", "removed", "unknown") {
			return invalid()
		}
		source := obj(o["source"])
		if !exact(source, []string{"originSystem", "externalStableId", "contentVersion", "originalAt", "issuer"}, []string{"contentHash", "uri", "owner"}) || !text(source, "originSystem", 1, 120, true) || !text(source, "externalStableId", 1, 1000, true) || !text(source, "contentVersion", 1, 240, true) || !text(source, "issuer", 1, 4000, true) || !date(source, "originalAt") {
			return invalid()
		}
		if _, ok := source["owner"]; ok && !text(source, "owner", 1, 4000, true) {
			return invalid()
		}
		if _, ok := source["contentHash"]; ok && !hashPattern.MatchString(str(source, "contentHash")) {
			return invalid()
		}
		if v, ok := source["uri"]; ok {
			uri, ok := v.(string)
			u, e := url.Parse(strings.TrimSpace(uri))
			if !ok || protocol.TextLength(uri) > 2048 || e != nil || u.Scheme == "" {
				return invalid()
			}
		}
	case "verification":
		if !reference(o["target"], true) || !safe(o, "scopeVersion", 1, 9007199254740991) || !one(o["method"], "participant-feedback", "requester-acceptance", "local-test", "unit-test", "integration-test", "build", "ci-report", "benchmark", "peer-review", "human-review", "agent-verifier", "production-validation", "enterprise-attestation", "external-system") || !one(o["observation"], "passed", "failed", "inconclusive", "accepted", "partially-accepted", "rejected", "comment") || !one(o["relationship"], "same-controller", "counterparty", "independent", "unknown") {
			return invalid()
		}
		conditions := obj(o["conditions"])
		if conditions == nil || len(conditions) > 30 {
			return invalid()
		}
		for k, v := range conditions {
			if protocol.TextLength(k) < 1 || protocol.TextLength(k) > 80 {
				return invalid()
			}
			switch x := v.(type) {
			case string:
				if protocol.TextLength(x) > 2000 {
					return invalid()
				}
			case bool:
			case json.Number:
				n, e := x.Float64()
				if e != nil || math.IsInf(n, 0) {
					return invalid()
				}
			default:
				return invalid()
			}
		}
		refs, ok := o["evidenceRefs"].([]any)
		if !ok || len(refs) > 50 {
			return invalid()
		}
		for _, r := range refs {
			if !reference(r, false) {
				return invalid()
			}
		}
	case "revoke":
		if !one(o["objectType"], "evidence", "verification") {
			return invalid()
		}
	}
	return o, nil
}
