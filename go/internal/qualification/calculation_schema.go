package qualification

import (
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

const calculationPurpose = "this-task-eligibility-computation-only"
const calculationDisclosure = "public-conditions-and-bounded-satisfaction-only; no-source-text-or-other-party-identity"

var isoDatetime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$`)

func parseDatetime(v any) (time.Time, error) {
	s, ok := v.(string)
	if !ok || !isoDatetime.MatchString(s) {
		return time.Time{}, fail("invalid_qualification_calculation", 400)
	}
	for _, format := range []string{time.RFC3339Nano, "2006-01-02T15:04Z"} {
		if t, e := time.Parse(format, s); e == nil {
			return t, nil
		}
	}
	return time.Time{}, fail("invalid_qualification_calculation", 400)
}
func trimJS(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func ParseCalculation(raw []byte) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_qualification_calculation", 400) }
	var p Object
	if len(raw) > 48000 || protocol.Decode(raw, &p) != nil || p == nil {
		return invalid()
	}
	if p["kind"] == "revoke" {
		if !queryClosed(p, []string{"id", "kind", "grantId", "reason"}, nil) || !uuidPattern.MatchString(str(p, "id")) || !uuidPattern.MatchString(str(p, "grantId")) {
			return invalid()
		}
		if _, ok := p["reason"].(string); !ok {
			return invalid()
		}
		p["reason"] = trimJS(str(p, "reason"))
		if !boundedString(p["reason"], 1, 1600) {
			return invalid()
		}
		return p, nil
	}
	required := []string{"id", "taskId", "candidateId", "recipientId", "purpose", "expiresAt", "sourceRefs", "disclosure", "kind"}
	if p["kind"] == "compute" {
		required = append(required, "permissionIds", "evidence")
	} else if p["kind"] != "source-permission" {
		return invalid()
	}
	if !queryClosed(p, required, nil) || !uuidPattern.MatchString(str(p, "id")) || !uuidPattern.MatchString(str(p, "taskId")) || !subjectPattern.MatchString(str(p, "candidateId")) || !subjectPattern.MatchString(str(p, "recipientId")) || p["purpose"] != calculationPurpose || p["disclosure"] != calculationDisclosure {
		return invalid()
	}
	if _, e := parseDatetime(p["expiresAt"]); e != nil {
		return invalid()
	}
	refs, ok := p["sourceRefs"].([]any)
	if !ok || len(refs) < 1 || len(refs) > 128 {
		return invalid()
	}
	for _, v := range refs {
		r := object(v)
		if !queryClosed(r, []string{"kind", "id", "eventVersion", "payloadHash"}, nil) || !hasString([]any{"case-event", "task-event", "experience-event"}, str(r, "kind")) || !uuidPattern.MatchString(str(r, "id")) || !registryVersionOne(r["eventVersion"]) || !sha256Pattern.MatchString(str(r, "payloadHash")) {
			return invalid()
		}
	}
	if p["kind"] == "compute" {
		if !uuidArray(p["permissionIds"], 64) {
			return invalid()
		}
		evidence := object(p["evidence"])
		if evidence == nil || evidence["calculationGrantId"] != nil {
			return invalid()
		} // Omit accepts no calculationGrantId, including null.
		if _, exists := evidence["calculationGrantId"]; exists {
			return invalid()
		}
		copy := Object{"taskId": p["taskId"], "subjectId": p["candidateId"], "evidence": evidence}
		raw, e := protocol.EncodeJS(copy)
		if e != nil {
			return invalid()
		}
		parsed, e := ParseQueryV2(raw)
		if e != nil {
			return invalid()
		}
		p["evidence"] = parsed["evidence"]
	}
	return p, nil
}
