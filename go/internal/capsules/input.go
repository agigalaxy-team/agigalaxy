package capsules

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const maxSafe int64 = 9007199254740991

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var capabilityPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var isoPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$`)

// These declarations mirror only the existing Capsule schemas. Normalization
// affects projected values; immutable signed payload_text is always retained.
type validator func(any) (any, bool)
type field struct {
	name     string
	parse    validator
	optional bool
	fallback any
}

func req(k string, v validator) field { return field{name: k, parse: v} }
func opt(k string, v validator) field { return field{name: k, parse: v, optional: true} }
func def(k string, v validator, f any) field {
	return field{name: k, parse: v, optional: true, fallback: f}
}
func shape(fields ...field) validator {
	return func(v any) (any, bool) {
		o := obj(v)
		if o == nil {
			return nil, false
		}
		allowed := map[string]bool{}
		out := protocol.NewOrderedObject()
		for _, f := range fields {
			allowed[f.name] = true
			x, present := o[f.name]
			if !present {
				if !f.optional {
					return nil, false
				}
				if f.fallback != nil {
					out.Set(f.name, f.fallback)
				}
				continue
			}
			x, ok := f.parse(x)
			if !ok {
				return nil, false
			}
			out.Set(f.name, x)
		}
		for k := range o {
			if !allowed[k] {
				return nil, false
			}
		}
		return out, true
	}
}
func jsTrim(v string) string {
	return strings.TrimFunc(v, func(r rune) bool {
		return r == 0xFEFF || r == 0xA0 || r == 0x1680 || r >= 0x2000 && r <= 0x200A || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f'
	})
}
func stringValue(min, max int, trim bool) validator {
	return func(v any) (any, bool) {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		if trim {
			s = jsTrim(s)
		}
		n := utf8.RuneCountInString(s)
		return s, n >= min && n <= max
	}
}
func pattern(re *regexp.Regexp) validator {
	return func(v any) (any, bool) { s, ok := v.(string); return s, ok && re.MatchString(s) }
}
func integer(min, max int64) validator {
	return func(v any) (any, bool) {
		var n float64
		switch x := v.(type) {
		case float64:
			n = x
		case int:
			n = float64(x)
		case int32:
			n = float64(x)
		case int64:
			n = float64(x)
		case json.Number:
			var err error
			n, err = x.Float64()
			if err != nil {
				return nil, false
			}
		default:
			return nil, false
		}
		return int64(n), !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= float64(max)
	}
}
func literal(want any) validator {
	return func(v any) (any, bool) {
		switch x := want.(type) {
		case string:
			s, ok := v.(string)
			return s, ok && s == x
		case bool:
			b, ok := v.(bool)
			return b, ok && b == x
		}
		return nil, false
	}
}
func enumeration(values ...string) validator {
	return func(v any) (any, bool) {
		s, ok := v.(string)
		if ok {
			for _, x := range values {
				if s == x {
					return s, true
				}
			}
		}
		return nil, false
	}
}
func boolean(v any) (any, bool) { x, ok := v.(bool); return x, ok }
func nullable(p validator) validator {
	return func(v any) (any, bool) {
		if v == nil {
			return nil, true
		}
		return p(v)
	}
}
func array(p validator, min, max int) validator {
	return func(v any) (any, bool) {
		x, ok := v.([]any)
		if !ok || len(x) < min || len(x) > max {
			return nil, false
		}
		out := make([]any, 0, len(x))
		for _, y := range x {
			z, ok := p(y)
			if !ok {
				return nil, false
			}
			out = append(out, z)
		}
		return out, true
	}
}
func unique(values []any) bool {
	seen := map[string]bool{}
	for _, v := range values {
		k := string(encode(v))
		if seen[k] {
			return false
		}
		seen[k] = true
	}
	return true
}
func dateTime(v any) (any, bool) {
	s, ok := v.(string)
	if !ok || !isoPattern.MatchString(s) {
		return nil, false
	}
	_, e := time.Parse(time.RFC3339Nano, s)
	return s, e == nil
}
func urlValue(v any) (any, bool) {
	s, ok := v.(string)
	if !ok {
		return nil, false
	}
	s = jsTrim(s)
	_, e := whatwg.Parse(s)
	return strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(s), e == nil
}

var idValue = pattern(uuidPattern)
var subjectValue = pattern(subjectPattern)
var refValue = shape(req("id", idValue), req("version", integer(1, maxSafe)))

func sourceValue(v any) (any, bool) {
	kind := text(obj(v), "kind")
	fields := []field{req("kind", enumeration("case-root", "attempt", "intervention", "result", "evidence", "verification", "configuration", "selected-message", "outcome-material")), req("id", idValue), req("version", integer(1, maxSafe))}
	if kind != "configuration" && kind != "selected-message" {
		fields = append(fields, req("caseId", idValue))
	}
	return shape(fields...)(v)
}
func environment(trim bool) validator {
	return shape(req("name", stringValue(1, 160, trim)), req("version", stringValue(1, 80, trim)))
}
func versionFields(v2 bool) []field {
	f := []field{req("id", idValue), req("capsuleId", idValue), req("kind", literal("version")), req("expectedRevision", integer(0, maxSafe)), req("version", integer(1, 100)), req("title", stringValue(1, 160, true)), req("problemPattern", stringValue(1, 1200, true)), req("environment", environment(true)), req("solutionStrategy", stringValue(1, 4000, true)), req("tools", array(stringValue(1, 160, true), 0, 16)), req("skills", array(stringValue(1, 160, true), 0, 16)), req("mcpRefs", array(stringValue(1, 160, true), 0, 16)), req("verificationMethod", stringValue(1, 1200, true)), req("limitations", array(stringValue(1, 1200, true), 1, 8)), req("capabilityId", pattern(capabilityPattern)), req("applicableScope", stringValue(1, 1200, true)), req("license", stringValue(1, 80, true)), req("contributors", array(subjectValue, 0, 16))}
	resolution := []field{req("caseId", idValue), req("resultId", idValue)}
	if v2 {
		resolution = append(resolution, req("resultVersion", integer(1, maxSafe)), def("proofIds", array(idValue, 0, 16), []any{}), def("verificationRefs", array(refValue, 0, 16), []any{}))
	} else {
		resolution = append(resolution, req("proofIds", array(idValue, 0, 16)))
	}
	f = append(f, req("sourceResolution", shape(resolution...)), req("redactionConfirmed", literal(true)))
	if v2 {
		f = append(f, req("schemaVersion", integer(2, 2)), req("publicationClass", literal("formal-source-success")), req("synthetic", boolean), req("sourceRefs", array(sourceValue, 0, 64)), req("permissionRefs", array(idValue, 0, 64)), req("attributionRefs", array(shape(req("subjectId", subjectValue), req("source", sourceValue)), 0, 32)), def("externalReferences", array(shape(req("url", urlValue), req("description", stringValue(1, 1600, true)), req("license", nullable(stringValue(0, 160, false))), req("inclusion", literal("reference-only; no-imported-body"))), 0, 16), []any{}))
	}
	return f
}
func eventValue(v any, v2 bool) (any, bool) {
	o := obj(v)
	kind := text(o, "kind")
	var p any
	var ok bool
	if kind == "version" {
		p, ok = shape(versionFields(v2)...)(v)
		if !ok {
			return nil, false
		}
		q := obj(p)
		return p, unique(list(q["contributors"])) && unique(list(obj(q["sourceResolution"])["proofIds"]))
	}
	f := []field{}
	if v2 {
		f = append(f, req("schemaVersion", integer(2, 2)))
	}
	f = append(f, req("id", idValue), req("capsuleId", idValue), req("expectedRevision", integer(1, maxSafe)), req("versionId", idValue), req("summary", stringValue(1, 1200, true)))
	if v2 {
		f[len(f)-1] = req("summary", stringValue(1, 1600, true))
	}
	f = append(f, req("kind", enumeration("deprecate", "security-issue", "resolve-security")))
	if kind == "deprecate" {
		f = append(f, opt("replacementVersionId", idValue))
	}
	return shape(f...)(v)
}
func permissionValue(v any) (any, bool) {
	if text(obj(v), "kind") == "revoke" {
		return shape(req("schemaVersion", integer(2, 2)), req("kind", literal("revoke")), req("id", idValue), req("permissionId", idValue), req("reason", stringValue(1, 1600, true)))(v)
	}
	p, ok := shape(req("schemaVersion", integer(2, 2)), req("kind", literal("grant")), req("id", idValue), req("sources", array(sourceValue, 1, 64)), req("grantees", array(subjectValue, 1, 32)), req("license", stringValue(1, 80, true)), req("scope", stringValue(1, 1600, true)), req("basis", enumeration("authored-content", "documented-covering-license")), opt("licenseReference", stringValue(1, 1200, true)), req("attribution", stringValue(1, 1600, true)), req("allowPublic", boolean), opt("expiresAt", dateTime))(v)
	return p, ok && (text(obj(p), "basis") != "documented-covering-license" || text(obj(p), "licenseReference") != "")
}
func useValue(v any, v2 bool) (any, bool) {
	o := obj(v)
	kind := text(o, "kind")
	f := []field{}
	if v2 {
		f = append(f, req("schemaVersion", integer(2, 2)))
	}
	f = append(f, req("id", idValue), req("capsuleId", idValue), req("versionId", idValue), req("caseId", idValue), req("attribution", subjectValue), req("note", stringValue(1, 1200, true)))
	if v2 {
		f[len(f)-1] = req("note", stringValue(1, 1600, true))
		f = append(f, opt("taskId", idValue), opt("participationId", idValue))
	}
	if kind != "reference" {
		if v2 {
			f = append(f, opt("attemptRef", refValue), opt("originRef", shape(req("kind", enumeration("attempt", "intervention")), req("id", idValue), req("version", integer(1, maxSafe)))), req("resultRef", refValue), opt("configurationRef", refValue))
		} else {
			f = append(f, req("attemptId", idValue), req("resultId", idValue))
		}
		f = append(f, req("environment", environment(!v2)), req("environmentDifference", stringValue(1, 1200, true)))
		if v2 {
			f[len(f)-1] = req("environmentDifference", stringValue(1, 1600, true))
			f = append(f, req("adoptedParts", array(stringValue(1, 1600, true), 1, 16)))
		}
		f = append(f, req("outcome", enumeration("succeeded", "partial", "failed", "inconclusive", "conflicting")))
	}
	f = append(f, req("kind", enumeration("reference", "apply", "reverify")))
	if kind == "reverify" {
		f = append(f, req("priorUseId", idValue))
		if v2 {
			f = append(f, req("verificationRefs", array(refValue, 1, 16)))
		} else {
			f = append(f, req("proofIds", array(idValue, 1, 16)))
		}
	}
	p, ok := shape(f...)(v)
	if !ok {
		return nil, false
	}
	q := obj(p)
	if v2 && kind != "reference" {
		origin := obj(q["originRef"])
		attempt := obj(q["attemptRef"])
		if origin == nil {
			if attempt == nil {
				return nil, false
			}
		} else if origin["kind"] == "intervention" {
			if attempt != nil {
				return nil, false
			}
		} else if attempt != nil && (origin["id"] != attempt["id"] || number(origin, "version") != number(attempt, "version")) {
			return nil, false
		}
		if q["configurationRef"] != nil && origin["kind"] != "intervention" {
			return nil, false
		}
	}
	return p, true
}
func parsePayload(raw string, kind string, v2 bool) (*protocol.OrderedObject, error) {
	max := 16000
	code := "invalid_capsule_payload"
	if v2 {
		max = 48000
		code = "invalid_capsule_v2_payload"
	}
	if len([]byte(raw)) > max || !utf8.ValidString(raw) {
		return nil, fault.New(code, 400)
	}
	o, e := protocol.DecodeOrdered([]byte(raw))
	if e != nil {
		return nil, fault.New(code, 400)
	}
	var p any
	var ok bool
	switch kind {
	case "permission":
		p, ok = permissionValue(o)
	case "use":
		p, ok = useValue(o, v2)
	default:
		p, ok = eventValue(o, v2)
	}
	if !ok {
		return nil, fault.New(code, 400)
	}
	return p.(*protocol.OrderedObject), nil
}
func parseInput(raw []byte, kind string) (Object, error) {
	o, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, fault.New("invalid_capsule_query", 400)
	}
	var p validator
	code := "invalid_capsule_query"
	switch kind {
	case "read":
		p = shape(req("capsuleId", idValue), opt("versionId", idValue))
	case "query":
		p = shape(def("query", stringValue(0, 200, true), ""), opt("capabilityId", pattern(capabilityPattern)), opt("authorId", subjectValue), opt("after", idValue), def("limit", integer(1, 20), int64(8)))
	case "uses":
		p = shape(opt("capsuleId", idValue), opt("versionId", idValue), opt("caseId", idValue), opt("after", idValue), def("limit", integer(1, 20), int64(8)))
	case "receipt":
		code = "invalid_capsule_receipt"
		p = shape(req("type", enumeration("publication", "use", "permission")), req("operationId", idValue), req("payloadHash", pattern(hashPattern)))
	case "versions":
		p = shape(req("capsuleId", idValue), opt("after", idValue), def("limit", integer(1, 50), int64(20)))
	case "permissions":
		p = shape(def("view", enumeration("owned", "granted"), "owned"), opt("after", idValue), def("limit", integer(1, 50), int64(20)))
	case "permission-read":
		p = shape(req("permissionId", idValue))
	case "preview":
		code = "invalid_capsule_v2_payload"
		p = shape(req("payload", func(v any) (any, bool) { return eventVersion(v) }), def("visibility", enumeration("Private", "Public"), "Public"))
	default:
		return nil, fault.New(code, 400)
	}
	x, ok := p(o)
	if !ok || kind == "uses" && text(obj(x), "capsuleId") == "" && text(obj(x), "caseId") == "" {
		return nil, fault.New(code, 400)
	}
	return obj(x), nil
}
func eventVersion(v any) (any, bool) {
	if text(obj(v), "kind") != "version" {
		return nil, false
	}
	return eventValue(v, true)
}
