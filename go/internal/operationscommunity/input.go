package operationscommunity

import (
	"encoding/json"
	"math"
	"strings"
	"unicode/utf8"
)

func invalid() error { return fail("invalid_operations_request", 400) }
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
func copyObject(x Object) Object {
	y := Object{}
	for k, v := range x {
		y[k] = v
	}
	return y
}
func text(x any) (string, bool) {
	s, ok := x.(string)
	if !ok {
		return "", false
	}
	s = strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
	n := utf8.RuneCountInString(s)
	return s, n >= 3 && n <= 1600
}
func parsePage(input Object, kind string) (Object, error) {
	x := copyObject(input)
	keys := []string{"after", "limit"}
	if kind == "sections" {
		keys = append(keys, "state", "category")
	}
	if kind == "reports" {
		keys = append(keys, "state")
	}
	if !strict(x, keys...) {
		return nil, invalid()
	}
	if v, ok := x["after"]; ok {
		_, ok := v.(string)
		if !ok || !validID(str(x, "after")) {
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
		allowed := []string{"active", "archived"}
		if kind == "reports" {
			allowed = []string{"pending", "appealed", "resolved", "withdrawn"}
		}
		s, ok := v.(string)
		if !ok || !has(allowed, s) {
			return nil, invalid()
		}
	}
	if v, ok := x["category"]; ok {
		s, ok := v.(string)
		if !ok || !has(categories, s) {
			return nil, invalid()
		}
	}
	return x, nil
}

var categories = []string{"technology", "arts", "learning", "life", "galaxy", "unclassified"}

func parseWrite(input Object, kind string) (Object, error) {
	x := copyObject(input)
	keys := []string{"operationId", "expectedVersion"}
	switch kind {
	case "classify":
		keys = append(keys, "category", "reason")
	case "visibility":
		keys = append(keys, "kind", "expectedVisibilityVersion", "reason")
		if str(x, "kind") == "hide" {
			keys = append(keys, "until")
		}
	case "resolve":
		keys = append(keys, "resolution", "summary", "restrictionAction", "hideUntil")
	}
	if !strict(x, keys...) || !validID(str(x, "operationId")) || !integer(x["expectedVersion"], 0, 2147483647) {
		return nil, invalid()
	}
	if kind == "resolve" {
		if !has([]string{"accepted", "dismissed", "needs-review"}, str(x, "resolution")) {
			return nil, invalid()
		}
		s, ok := text(x["summary"])
		if !ok {
			return nil, invalid()
		}
		x["summary"] = s
		action := "keep"
		if _, ok := x["hideUntil"]; ok {
			action = "hide"
			if !integer(x["hideUntil"], 1, 9007199254740991) {
				return nil, invalid()
			}
		}
		if v, ok := x["restrictionAction"]; ok {
			action, _ = v.(string)
			if !has([]string{"keep", "release", "hide"}, action) {
				return nil, invalid()
			}
		}
		_, until := x["hideUntil"]
		if (action == "hide") != until {
			return nil, invalid()
		}
		return x, nil
	}
	reason, ok := text(x["reason"])
	if !ok {
		return nil, invalid()
	}
	x["reason"] = reason
	if kind == "classify" {
		if !has(categories, str(x, "category")) {
			return nil, invalid()
		}
	} else {
		if !has([]string{"hide", "restore"}, str(x, "kind")) || !integer(x["expectedVisibilityVersion"], 0, 2147483647) {
			return nil, invalid()
		}
		if str(x, "kind") == "hide" && !integer(x["until"], 1, 9007199254740991) {
			return nil, invalid()
		}
	}
	return x, nil
}
