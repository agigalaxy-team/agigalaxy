package filegovernance

import (
	"encoding/json"
	"math"
	"regexp"
	"unicode/utf8"
)

var fileUUID = regexp.MustCompile(`(?i)^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func space(r rune) bool {
	return r >= 9 && r <= 13 || r == 32 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func trim(s string) string {
	r := []rune(s)
	first, last := 0, len(r)
	for first < last && space(r[first]) {
		first++
	}
	for last > first && space(r[last-1]) {
		last--
	}
	return string(r[first:last])
}
func integer(v any, min, max int64) bool {
	var n float64
	switch v := v.(type) {
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
	return !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && n >= float64(min) && n <= float64(max)
}
func exact(x Object, keys ...string) bool {
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
func invalid() error { return fail("invalid_operations_request", 400) }
func parseObject(raw []byte) (Object, error) {
	var x Object
	if json.Unmarshal(raw, &x) != nil || x == nil {
		return nil, invalid()
	}
	return x, nil
}
func text(x Object, key string, min, max int, trimmed bool) bool {
	s, ok := x[key].(string)
	if !ok {
		return false
	}
	if trimmed {
		s = trim(s)
		x[key] = s
	}
	n := utf8.RuneCountInString(s)
	return n >= min && n <= max
}
func ParseRetry(input Object) (Object, error) {
	x := Object{}
	for k, v := range input {
		x[k] = v
	}
	if !exact(x, "operationId", "kind", "expectedVersion", "reason") || !fileUUID.MatchString(str(x, "operationId")) || !has([]string{"scan", "cleanup"}, str(x, "kind")) || !text(x, "expectedVersion", 1, 512, false) || !text(x, "reason", 3, 1600, true) {
		return nil, invalid()
	}
	return x, nil
}
func ParseAccessChange(input Object) (Object, error) {
	x := Object{}
	for k, v := range input {
		x[k] = v
	}
	if !fileUUID.MatchString(str(x, "operationId")) || !text(x, "expectedVersion", 1, 8192, false) || !integer(x["expectedRevision"], 0, 9007199254740991) || !text(x, "reason", 3, 1600, true) {
		return nil, invalid()
	}
	if str(x, "action") == "stop" {
		if !exact(x, "operationId", "expectedVersion", "expectedRevision", "reason", "action", "until") || !integer(x["until"], 1, 253402300799) {
			return nil, invalid()
		}
	} else if str(x, "action") != "restore" || !exact(x, "operationId", "expectedVersion", "expectedRevision", "reason", "action") {
		return nil, invalid()
	}
	return x, nil
}
