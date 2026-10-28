package contributions

import (
	"math"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
)

var uuidPattern = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var isoPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$`)

func date(v any) (time.Time, error) {
	s, ok := v.(string)
	if ok && isoPattern.MatchString(s) {
		for _, f := range []string{time.RFC3339Nano, "2006-01-02T15:04Z"} {
			if t, e := time.Parse(f, s); e == nil {
				return t, nil
			}
		}
	}
	return time.Time{}, fail("invalid_contribution_publication", 400)
}
func sourceRef(ref Object, projected bool) bool {
	required := []string{"kind", "id", "eventVersion", "payloadHash"}
	if projected {
		required = append(required, "fields")
	}
	if !closed(ref, required, nil) || !has([]string{"case-event", "task-event"}, str(ref, "kind")) || !uuidPattern.MatchString(str(ref, "id")) || !hashPattern.MatchString(str(ref, "payloadHash")) {
		return false
	}
	switch n := ref["eventVersion"].(type) {
	case float64:
		if n != 1 {
			return false
		}
	case int:
		if n != 1 {
			return false
		}
	case int64:
		if n != 1 {
			return false
		}
	default:
		return false
	}
	if !projected {
		return true
	}
	fields, ok := ref["fields"].([]any)
	if !ok || len(fields) < 2 || len(fields) > len(ProjectionFields) {
		return false
	}
	seen := map[string]bool{}
	for _, v := range fields {
		f, ok := v.(string)
		if !ok || !has(ProjectionFields, f) || seen[f] {
			return false
		}
		seen[f] = true
	}
	return seen["eventType"] && seen["actorId"]
}
func parseRefsAndPurposes(input Object) bool {
	refs, ok := input["sourceRefs"].([]any)
	if !ok || len(refs) < 1 || len(refs) > 128 {
		return false
	}
	for _, v := range refs {
		if !sourceRef(object(v), true) {
			return false
		}
	}
	purposes, ok := input["purposes"].([]any)
	if !ok || len(purposes) < 1 || len(purposes) > 2 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range purposes {
		p, ok := v.(string)
		if !ok || !has([]string{"honor", "requester-history"}, p) || seen[p] {
			return false
		}
		seen[p] = true
	}
	return true
}
func ParsePublication(raw []byte) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_contribution_publication", 400) }
	if len(raw) > 48000 {
		return invalid()
	}
	v, e := jstext.DecodeJSON(raw)
	if e != nil {
		return invalid()
	}
	p := object(v)
	if p == nil || !uuidPattern.MatchString(str(p, "id")) {
		return invalid()
	}
	if p["kind"] == "publish" {
		if !closed(p, []string{"id", "kind", "sourceRefs", "purposes", "purpose", "expiresAt", "redactionConfirmed", "publicationScope"}, nil) || !parseRefsAndPurposes(p) || p["purpose"] != "public-contribution-projections-only" || p["redactionConfirmed"] != true || p["publicationScope"] != PublicationScope {
			return invalid()
		}
		if _, e = date(p["expiresAt"]); e != nil {
			return invalid()
		}
		return p, nil
	}
	if p["kind"] != "revoke" || !closed(p, []string{"id", "kind", "publicationId", "reason"}, nil) || !uuidPattern.MatchString(str(p, "publicationId")) {
		return invalid()
	}
	var reason jstext.String
	switch v := p["reason"].(type) {
	case string:
		reason = jstext.From(v)
	case jstext.String:
		reason = v
	default:
		return invalid()
	}
	reason = reason.Trim()
	if reason.CodePointLen() < 1 || reason.CodePointLen() > 1600 {
		return invalid()
	}
	if reason.HasUnpaired() {
		p["reason"] = reason
	} else {
		p["reason"] = reason.Decoded()
	}
	return p, nil
}
func integer(v any, min, max int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= max
	case int64:
		return n >= min && n <= max
	case float64:
		return n >= float64(min) && n <= float64(max) && math.Trunc(n) == n
	}
	return false
}
func stringsIn(v any) []string {
	out := []string{}
	for _, v := range array(v) {
		out = append(out, text(v))
	}
	return out
}
