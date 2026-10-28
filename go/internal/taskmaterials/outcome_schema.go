package taskmaterials

import (
	"math"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Envelope struct {
	ConsentID   string `json:"consentId"`
	PayloadJSON string `json:"payloadJson"`
}
type outcomeEvent struct {
	Input                               Object
	PayloadText, PayloadHash, ConsentID string
}

func validSource(v Object) bool {
	return exactFields(v, []string{"kind", "id", "version", "sha256", "roomId"}, nil) && contains([]string{"message", "attachment"}, str(v, "kind")) && validID(str(v, "id")) && validInt(v["version"], 1, math.MaxInt64) && hashPattern.MatchString(str(v, "sha256")) && validID(str(v, "roomId"))
}
func isoDate(v any) bool {
	s, ok := v.(string)
	if !ok || !strings.HasSuffix(s, "Z") {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, s)
	return e == nil
}
func trimmed(v Object, key string, max int) bool {
	s, ok := v[key].(string)
	if !ok {
		return false
	}
	s = jsTrim(s)
	v[key] = s
	return protocol.TextLength(s) > 0 && protocol.TextLength(s) <= max
}
func parseOutcome(input Envelope, kinds ...string) (outcomeEvent, error) {
	out := outcomeEvent{PayloadText: input.PayloadJSON, PayloadHash: identity.Digest([]byte(input.PayloadJSON)), ConsentID: input.ConsentID}
	invalid := func() (outcomeEvent, error) { return out, fail("invalid_outcome_material_request", 400) }
	if !validID(input.ConsentID) || len([]byte(input.PayloadJSON)) > 24000 {
		return invalid()
	}
	x, e := parseObject(input.PayloadJSON)
	if e != nil || !validID(str(x, "id")) || !validID(str(x, "materialId")) || !contains(kinds, str(x, "kind")) {
		return invalid()
	}
	switch str(x, "kind") {
	case "request":
		if !exactFields(x, []string{"id", "materialId", "kind", "source", "caseId", "purpose", "title", "audience", "uses", "retention", "requestExpiresAt"}, []string{"taskId", "participationId"}) || !validSource(obj(x, "source")) || !validID(str(x, "caseId")) || !trimmed(x, "purpose", 1600) || !trimmed(x, "title", 160) || str(x, "retention") != "with-related-result; independently-authorized-copy" || !isoDate(x["requestExpiresAt"]) {
			return invalid()
		}
		for _, key := range []string{"taskId", "participationId"} {
			if value, ok := x[key]; ok && !validID(text(value)) {
				return invalid()
			}
		}
		audience := obj(x, "audience")
		if _, ok := audience["viewers"]; !ok && audience != nil {
			audience["viewers"] = []any{}
		}
		if !exactFields(audience, []string{"visibility", "viewers"}, nil) || !contains([]string{"Private", "Public"}, str(audience, "visibility")) {
			return invalid()
		}
		viewers, ok := audience["viewers"].([]any)
		if !ok || len(viewers) > 16 {
			return invalid()
		}
		for _, v := range viewers {
			if !subjectPattern.MatchString(text(v)) {
				return invalid()
			}
		}
		uses, ok := x["uses"].([]any)
		if !ok || len(uses) < 1 || len(uses) > 2 {
			return invalid()
		}
		for _, v := range uses {
			if !contains([]string{"evidence", "capsule-publication"}, text(v)) {
				return invalid()
			}
		}
	case "approve":
		if !exactFields(x, []string{"id", "materialId", "kind", "expectedRevision", "requestHash", "source", "license", "basis", "scope", "independentRetention", "temporarySourceExpiryRevokesCopy"}, []string{"licenseReference", "expiresAt"}) || !validInt(x["expectedRevision"], 1, math.MaxInt64) || !hashPattern.MatchString(str(x, "requestHash")) || !validSource(obj(x, "source")) || !trimmed(x, "license", 80) || !contains([]string{"authored-content", "documented-covering-license"}, str(x, "basis")) || !trimmed(x, "scope", 1600) || x["independentRetention"] != true || x["temporarySourceExpiryRevokesCopy"] != false {
			return invalid()
		}
		if _, ok := x["licenseReference"]; ok {
			if !trimmed(x, "licenseReference", 1600) {
				return invalid()
			}
		} else if str(x, "basis") == "documented-covering-license" {
			return invalid()
		}
		if value, ok := x["expiresAt"]; ok && !isoDate(value) {
			return invalid()
		}
	case "decline", "cancel", "revoke":
		if !exactFields(x, []string{"id", "materialId", "kind", "expectedRevision", "reason"}, nil) || !validInt(x["expectedRevision"], 1, math.MaxInt64) || !trimmed(x, "reason", 1600) {
			return invalid()
		}
	default:
		return invalid()
	}
	out.Input = x
	return out, nil
}
func jsTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r == 0x9 || r == 0xa || r == 0xb || r == 0xc || r == 0xd || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	})
}
