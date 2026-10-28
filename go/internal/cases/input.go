package cases

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"regexp"
	"strings"
	"unicode"
)

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var refPattern = regexp.MustCompile(`^[a-zA-Z0-9:_-]{1,128}$`)
var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func shape(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	keys := map[string]bool{}
	for _, k := range required {
		keys[k] = true
		if _, ok := o[k]; !ok {
			return false
		}
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
func bounded(o Object, k string, min, max int, trim bool) bool {
	s, ok := o[k].(string)
	if !ok {
		return false
	}
	if trim {
		s = trimJS(s)
		o[k] = s
	}
	return protocol.TextLength(s) >= min && protocol.TextLength(s) <= max
}
func trimJS(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return r != '\u0085' && unicode.IsSpace(r) || r == '\ufeff' })
}
func integer(o Object, k string, min int64) bool {
	var f float64
	switch n := o[k].(type) {
	case json.Number:
		var e error
		f, e = n.Float64()
		if e != nil {
			return false
		}
	case float64:
		f = n
	case int64:
		f = float64(n)
	case int:
		f = float64(n)
	case int32:
		f = float64(n)
	default:
		return false
	}
	return !math.IsInf(f, 0) && math.Trunc(f) == f && f >= float64(min) && f <= 9007199254740991
}
func uuidField(o Object, k string) bool { return uuidPattern.MatchString(text(o, k)) }
func stringsList(v any, min, max, length int) bool {
	a, ok := v.([]any)
	if !ok || len(a) < min || len(a) > max {
		return false
	}
	for _, v := range a {
		s, ok := v.(string)
		if !ok || protocol.TextLength(s) < 1 || protocol.TextLength(s) > length {
			return false
		}
	}
	return true
}
func parseLegacy(raw string) (Object, error) {
	invalid := func() (Object, error) { return nil, fault.New("invalid_case_payload", 400) }
	if len(raw) > 12000 {
		return invalid()
	}
	var o Object
	if protocol.Decode([]byte(raw), &o) != nil {
		return invalid()
	}
	kind := text(o, "kind")
	common := []string{"kind", "id", "caseId", "expectedVersion"}
	req := append([]string{}, common...)
	opt := []string{}
	switch kind {
	case "case":
		req = []string{"kind", "id", "localRef", "title", "summary", "source", "participants"}
	case "attempt":
		req = append(req, "sequence", "approach", "configuration")
	case "result":
		req = append(req, "attemptId", "outcome", "summary", "failureReason", "limitations")
	case "revision":
		req = append(req, "correctsEventId", "reason", "summary")
		opt = []string{"review"}
	case "withdrawal":
		req = append(req, "reason")
	default:
		return invalid()
	}
	if !shape(o, req, opt) || !uuidField(o, "id") {
		return invalid()
	}
	if kind != "case" && (!uuidField(o, "caseId") || !integer(o, "expectedVersion", 1)) {
		return invalid()
	}
	valid := true
	switch kind {
	case "case":
		source := object(o["source"])
		participants, ok := o["participants"].([]any)
		valid = refPattern.MatchString(text(o, "localRef")) && bounded(o, "title", 1, 160, true) && bounded(o, "summary", 1, 1200, true) && shape(source, []string{"kind", "reference"}, nil) && one(source["kind"], "local", "bridge", "hub") && refPattern.MatchString(text(source, "reference")) && ok && len(participants) >= 1 && len(participants) <= 16
		for _, p := range participants {
			p := object(p)
			valid = valid && shape(p, []string{"subjectId", "role"}, nil) && subjectPattern.MatchString(text(p, "subjectId")) && one(p["role"], "requester", "provider", "contributor")
		}
	case "attempt":
		c := object(o["configuration"])
		valid = integer(o, "sequence", 1) && bounded(o, "approach", 1, 1200, true) && shape(c, []string{"environment", "version", "tools"}, nil) && bounded(c, "environment", 1, 160, false) && bounded(c, "version", 1, 80, false) && stringsList(c["tools"], 0, 16, 80)
	case "result":
		valid = uuidField(o, "attemptId") && one(o["outcome"], "succeeded", "partial", "failed", "inconclusive", "conflicting") && bounded(o, "summary", 1, 1200, true) && bounded(o, "failureReason", 0, 1200, false) && stringsList(o["limitations"], 0, 16, 400)
	case "revision":
		valid = uuidField(o, "correctsEventId") && bounded(o, "reason", 1, 1200, true) && bounded(o, "summary", 1, 1200, true)
		if r, present := o["review"]; present {
			r := object(r)
			valid = valid && shape(r, []string{"threadId", "type", "state"}, nil) && uuidField(r, "threadId") && one(r["type"], "correction", "dispute") && one(r["state"], "opened", "in-review", "resolved", "rejected", "reopened")
		}
	case "withdrawal":
		valid = bounded(o, "reason", 1, 1200, true)
	}
	if !valid {
		return invalid()
	}
	return o, nil
}

func envelope(raw []byte) (string, string, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || !shape(o, []string{"consentId", "payloadJson"}, nil) || !uuidField(o, "consentId") {
		return "", "", fault.New("invalid_request", 400)
	}
	payload, ok := o["payloadJson"].(string)
	if !ok {
		return "", "", fault.New("invalid_request", 400)
	}
	return text(o, "consentId"), payload, nil
}
func parseLoose(raw []byte) (Object, error) {
	var v any
	if protocol.Decode(raw, &v) != nil {
		return nil, fault.New("invalid_request", 400)
	}
	if object(v) == nil {
		return nil, fault.New("invalid_request", 400)
	}
	return object(v), nil
}
