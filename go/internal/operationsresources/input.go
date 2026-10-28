package operationsresources

import (
	"encoding/json"
	"math"
	"strings"
	"unicode/utf8"
)

func has(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func integer(v any, min, max int64) bool {
	var n float64
	switch x := v.(type) {
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
	return !math.IsNaN(n) && n == math.Trunc(n) && n >= float64(min) && n <= float64(max)
}
func copyObject(x Object) Object {
	out := Object{}
	for k, v := range x {
		out[k] = v
	}
	return out
}
func strict(x Object, keys ...string) bool {
	if x == nil {
		return false
	}
	for k := range x {
		if !has(keys, k) {
			return false
		}
	}
	return true
}
func parsePage(input Object) (Object, error) {
	x := copyObject(input)
	if !strict(x, "after", "limit", "state") {
		return nil, invalid()
	}
	if v, ok := x["after"]; ok {
		s, ok := v.(string)
		if !ok || !validID(s) {
			return nil, invalid()
		}
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = 25
	}
	if !integer(x["limit"], 1, 100) {
		return nil, invalid()
	}
	if v, ok := x["state"]; ok {
		s, ok := v.(string)
		if !ok || !has([]string{"active", "archived"}, s) {
			return nil, invalid()
		}
	}
	return x, nil
}
func parseVisibility(input Object) (Object, error) {
	x := copyObject(input)
	keys := []string{"operationId", "kind", "expectedVersion", "expectedVisibilityVersion", "reason"}
	hide := str(x, "kind") == "hide"
	if hide {
		keys = append(keys, "until")
	}
	if !strict(x, keys...) || !validID(str(x, "operationId")) || !has([]string{"hide", "restore"}, str(x, "kind")) || !integer(x["expectedVersion"], 0, 2147483647) || !integer(x["expectedVisibilityVersion"], 0, 2147483647) || hide && !integer(x["until"], 1, 9007199254740991) {
		return nil, invalid()
	}
	reason, ok := x["reason"].(string)
	if !ok {
		return nil, invalid()
	}
	reason = strings.Trim(reason, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
	if utf8.RuneCountInString(reason) < 3 || utf8.RuneCountInString(reason) > 1600 {
		return nil, invalid()
	}
	x["reason"] = reason
	return x, nil
}
