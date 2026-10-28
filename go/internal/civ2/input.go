package civ2

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"regexp"
)

type Object = map[string]any

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

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
	switch n := o[k].(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func safe(o Object, k string, min, max int64) bool {
	var n float64
	switch v := o[k].(type) {
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case float64:
		n = v
	case json.Number:
		var e error
		n, e = v.Float64()
		if e != nil {
			return false
		}
	default:
		return false
	}
	return math.Trunc(n) == n && !math.IsInf(n, 0) && n >= float64(min) && n <= float64(max)
}
func exact(o Object, keys []string) bool {
	if o == nil || len(o) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	return true
}
func ref(v any) bool {
	o := obj(v)
	return exact(o, []string{"id", "version"}) && uuidPattern.MatchString(str(o, "id")) && safe(o, "version", 1, 9007199254740991)
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
func encode(v any) []byte { raw, _ := protocol.EncodeJS(v); return raw }
func copyObject(o Object) Object {
	v := Object{}
	for k, x := range o {
		v[k] = x
	}
	return v
}
func ordered(fields ...any) *protocol.OrderedObject {
	v := protocol.NewOrderedObject()
	for i := 0; i < len(fields); i += 2 {
		v.Set(fields[i].(string), fields[i+1])
	}
	return v
}
func flags(o Object) Object {
	o["taskOutcomeVerified"] = false
	o["capabilityVerified"] = false
	o["independentExecutionVerified"] = false
	return o
}
func parseRequest(raw []byte) (Object, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || !exact(o, []string{"id", "schemaVersion", "kind", "purpose", "caseId", "evidenceRef", "resultRef", "source"}) || !uuidPattern.MatchString(str(o, "id")) || !safe(o, "schemaVersion", 2, 2) || o["kind"] != "observe" || o["purpose"] != "observe-selected-ci-source-and-prepare-bounded-proof" || !uuidPattern.MatchString(str(o, "caseId")) || !ref(o["evidenceRef"]) || !ref(o["resultRef"]) {
		return nil, fault.New("invalid_ci_request", 422)
	}
	if _, e := (evidence.GithubSource{}).Reference(o["source"]); e != nil {
		return nil, fault.New("invalid_ci_request", 422)
	}
	return o, nil
}
func parseID(raw []byte, code string) (string, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || !exact(o, []string{"id"}) || !uuidPattern.MatchString(str(o, "id")) {
		return "", fault.New(code, 422)
	}
	return str(o, "id"), nil
}
func parsePreview(raw []byte, code string) (Object, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || !exact(o, []string{"id", "requestId"}) || !uuidPattern.MatchString(str(o, "id")) || !uuidPattern.MatchString(str(o, "requestId")) {
		return nil, fault.New(code, 422)
	}
	return o, nil
}
func envelope(raw []byte) (string, string, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil {
		return "", "", fault.New("invalid_request", 400)
	}
	p, ok := o["payloadJson"].(string)
	if !ok {
		return "", "", fault.New("invalid_request", 400)
	}
	return str(o, "consentId"), p, nil
}
func metadata(source Object) Object {
	return Object{"originSystem": "github-actions", "externalStableId": fmtSource(source), "contentVersion": source["commit"]}
}
