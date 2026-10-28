package moderation

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"unicode/utf8"
)

func strict(x Object, keys ...string) bool {
	allowed := map[string]bool{}
	for _, k := range keys {
		allowed[k] = true
	}
	for k := range x {
		if !allowed[k] {
			return false
		}
	}
	return true
}
func integer(v any, min, max int64) (int64, bool) {
	var n float64
	switch x := v.(type) {
	case json.Number:
		n, _ = x.Float64()
	case float64:
		n = x
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case int32:
		n = float64(x)
	case int16:
		n = float64(x)
	default:
		return 0, false
	}
	return int64(n), !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && n >= float64(min) && n <= float64(max)
}
func trim(s string) string {
	r := []rune(s)
	space := func(c rune) bool {
		return c >= 9 && c <= 13 || c == 32 || c == 0xa0 || c == 0x1680 || c >= 0x2000 && c <= 0x200a || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff
	}
	i, j := 0, len(r)
	for i < j && space(r[i]) {
		i++
	}
	for j > i && space(r[j-1]) {
		j--
	}
	return string(r[i:j])
}
func invalid() error { return fail("invalid_moderation_payload", 409) }
func text(x Object, k string) bool {
	v, ok := x[k].(string)
	v = trim(v)
	x[k] = v
	return ok && v != "" && utf8.RuneCountInString(v) <= 1200
}
func validTarget(x Object) bool {
	if x == nil {
		return false
	}
	if _, ok := x["caseId"]; ok {
		if !strict(x, "caseId", "caseVersion", "targetEventId", "evidenceId") || !opportunities.UUID.MatchString(str(x, "caseId")) || !opportunities.UUID.MatchString(str(x, "targetEventId")) {
			return false
		}
		if _, ok := x["evidenceId"]; ok && !opportunities.UUID.MatchString(str(x, "evidenceId")) {
			return false
		}
		n, ok := integer(x["caseVersion"], 1, 1000)
		x["caseVersion"] = n
		return ok
	}
	return strict(x, "assistanceId") && opportunities.UUID.MatchString(str(x, "assistanceId"))
}
func parseReferences(x Object) bool {
	if _, ok := x["references"]; !ok {
		x["references"] = []any{}
	}
	values, ok := x["references"].([]any)
	if !ok || len(values) > 8 {
		return false
	}
	for _, v := range values {
		r, ok := v.(map[string]any)
		if !ok {
			return false
		}
		if r["kind"] == "artifact" {
			if !strict(r, "kind", "sha256") || !digestText(str(r, "sha256")) {
				return false
			}
		} else if !strict(r, "kind", "id") || !has([]string{"case", "evidence", "proof", "event"}, str(r, "kind")) || !opportunities.UUID.MatchString(str(r, "id")) {
			return false
		}
	}
	return true
}
func ParsePayload(raw []byte, report bool) (Object, error) {
	if len(raw) > 16000 {
		return nil, invalid()
	}
	var x Object
	if protocol.Decode(raw, &x) != nil || x == nil || !opportunities.UUID.MatchString(str(x, "id")) || !text(x, "summary") {
		return nil, invalid()
	}
	if report {
		if !has([]string{"abuse", "privacy", "misrepresentation", "scope", "other", "malicious-artifact", "data-extraction", "work-fraud", "false-verification"}, str(x, "category")) {
			return nil, invalid()
		}
		target := Object{}
		for _, k := range []string{"assistanceId", "caseId", "caseVersion", "targetEventId", "evidenceId"} {
			if v, ok := x[k]; ok {
				target[k] = v
			}
		}
		if !validTarget(target) || !strict(x, "id", "category", "summary", "assistanceId", "caseId", "caseVersion", "targetEventId", "evidenceId") {
			return nil, invalid()
		}
		return x, nil
	}
	n, ok := integer(x["expectedVersion"], 1, 9007199254740991)
	if !ok || !opportunities.UUID.MatchString(str(x, "reportId")) {
		return nil, invalid()
	}
	x["expectedVersion"] = n
	keys := []string{"id", "reportId", "expectedVersion", "summary", "kind"}
	switch str(x, "kind") {
	case "pause", "resume", "appeal":
	case "resolve":
		keys = append(keys, "verdict")
		if !has([]string{"upheld", "dismissed"}, str(x, "verdict")) {
			return nil, invalid()
		}
	case "revalidate":
		keys = append(keys, "evidenceId")
		if !opportunities.UUID.MatchString(str(x, "evidenceId")) {
			return nil, invalid()
		}
	case "supplement":
		keys = append(keys, "references")
		if !parseReferences(x) {
			return nil, invalid()
		}
	case "correct":
		keys = append(keys, "correctsEventId", "reason")
		if !opportunities.UUID.MatchString(str(x, "correctsEventId")) || !text(x, "reason") {
			return nil, invalid()
		}
	case "invite-verifier":
		keys = append(keys, "verifierId", "target", "scope", "expiresAt")
		if !opportunities.Subject.MatchString(str(x, "verifierId")) || !validTarget(obj(x, "target")) || !text(x, "scope") {
			return nil, invalid()
		}
		n, ok = integer(x["expiresAt"], 1, 9007199254740991)
		if !ok {
			return nil, invalid()
		}
		x["expiresAt"] = n
	case "accept-verifier", "decline-verifier", "withdraw-verifier":
		keys = append(keys, "invitationId")
		if !opportunities.UUID.MatchString(str(x, "invitationId")) {
			return nil, invalid()
		}
	case "verification-response":
		keys = append(keys, "invitationId", "conclusion", "references")
		if !opportunities.UUID.MatchString(str(x, "invitationId")) || !has([]string{"supported", "unsupported", "inconclusive"}, str(x, "conclusion")) || !parseReferences(x) {
			return nil, invalid()
		}
	default:
		return nil, invalid()
	}
	if !strict(x, keys...) {
		return nil, invalid()
	}
	return x, nil
}
