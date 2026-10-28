package qualification

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func requestInvalid() (Object, error) {
	return nil, fail("invalid_qualification_permission_request", 400)
}
func parsePlan(input Object) (Object, error) {
	if !queryClosed(input, []string{"taskId", "expiresAt"}, []string{"participationIds", "externalReviewRefs"}) || !uuidPattern.MatchString(str(input, "taskId")) {
		return requestInvalid()
	}
	if _, e := parseDatetime(input["expiresAt"]); e != nil {
		return requestInvalid()
	}
	raw, e := protocol.EncodeJS(Object{"taskId": input["taskId"], "subjectId": "GUID0000000000000000000000000000", "evidence": Object{"participationIds": defaultArray(input, "participationIds"), "externalReviewRefs": defaultArray(input, "externalReviewRefs")}})
	if e != nil {
		return requestInvalid()
	}
	parsed, e := ParseQueryV2(raw)
	if e != nil {
		return requestInvalid()
	}
	evidence := object(parsed["evidence"])
	if len(array(evidence["participationIds"]))+len(array(evidence["externalReviewRefs"])) == 0 {
		return requestInvalid()
	}
	out := Object{}
	for k, v := range input {
		out[k] = v
	}
	out["participationIds"], out["externalReviewRefs"] = evidence["participationIds"], evidence["externalReviewRefs"]
	return out, nil
}
func defaultArray(input Object, key string) any {
	if v, ok := input[key]; ok {
		return v
	}
	return []any{}
}
func ParseRequestEvent(raw []byte) (Object, error) {
	var p Object
	if protocol.Decode(raw, &p) != nil || p == nil {
		return requestInvalid()
	}
	common := []string{"eventId", "requestId", "expectedVersion", "kind"}
	kind := str(p, "kind")
	switch kind {
	case "request":
		common = append(common, "taskId", "sourceAuthorId", "sourceRefs", "expiresAt", "purpose")
		if !queryClosed(p, common, []string{"participationIds", "externalReviewRefs"}) {
			return requestInvalid()
		}
		plan, e := parsePlan(Object{"taskId": p["taskId"], "expiresAt": p["expiresAt"], "participationIds": defaultArray(p, "participationIds"), "externalReviewRefs": defaultArray(p, "externalReviewRefs")})
		if e != nil || !subjectPattern.MatchString(str(p, "sourceAuthorId")) || p["purpose"] != "request-scoped-qualification-permission-only; no-permission-granted" {
			return requestInvalid()
		}
		p["participationIds"], p["externalReviewRefs"] = plan["participationIds"], plan["externalReviewRefs"]
		refs, ok := p["sourceRefs"].([]any)
		if !ok || len(refs) < 1 || len(refs) > 128 {
			return requestInvalid()
		}
		for _, v := range refs {
			r := object(v)
			if !queryClosed(r, []string{"kind", "id", "eventVersion", "payloadHash"}, nil) || !hasString([]any{"case-event", "task-event", "experience-event"}, str(r, "kind")) || !uuidPattern.MatchString(str(r, "id")) || !registryVersionOne(r["eventVersion"]) || !sha256Pattern.MatchString(str(r, "payloadHash")) {
				return requestInvalid()
			}
		}
	case "cancel", "decline":
		if !queryClosed(p, append(common, "reason"), nil) {
			return requestInvalid()
		}
		if _, ok := p["reason"].(string); !ok {
			return requestInvalid()
		}
		p["reason"] = trimJS(str(p, "reason"))
		if !boundedString(p["reason"], 1, 500) {
			return requestInvalid()
		}
	case "record-permission":
		if !queryClosed(p, append(common, "grantId"), nil) || !uuidPattern.MatchString(str(p, "grantId")) {
			return requestInvalid()
		}
	default:
		return requestInvalid()
	}
	if !uuidPattern.MatchString(str(p, "eventId")) || !uuidPattern.MatchString(str(p, "requestId")) || !(registryZero(p["expectedVersion"]) || positiveInteger(p["expectedVersion"])) {
		return requestInvalid()
	}
	return p, nil
}
func registryZero(v any) bool {
	switch n := v.(type) {
	case nil, bool, string:
		return false
	default:
		raw, e := protocol.EncodeJS(n)
		if e != nil {
			return false
		}
		var f float64
		return protocol.Decode(raw, &f) == nil && f == 0
	}
}
