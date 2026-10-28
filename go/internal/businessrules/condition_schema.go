package businessrules

import (
	"encoding/json"
	"github.com/google/uuid"
	"math"
	"strings"
)

// ParseCondition is the original p14ConditionSchema only. Owning controls and
// strategies retain their respective supported fields, depth and total limits.
// An iterative walk avoids overflowing before those original checks run.
func ParseCondition(value Object) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_operations_rule_request", 400) }
	type entry struct {
		input, out Object
		root       bool
	}
	out := Object{}
	stack := []entry{{value, out, true}}
	for len(stack) > 0 {
		last := len(stack) - 1
		item := stack[last]
		stack = stack[:last]
		x := item.input
		if x == nil {
			return invalid()
		}
		if _, branch := x["rules"]; branch || item.root {
			if len(x) != 2 || x["combinator"] != "and" && x["combinator"] != "or" {
				return invalid()
			}
			for k := range x {
				if k != "combinator" && k != "rules" {
					return invalid()
				}
			}
			children, ok := objects(x["rules"])
			if !ok || len(children) < 1 || len(children) > 20 {
				return invalid()
			}
			normalized := []any{}
			for _, child := range children {
				next := Object{}
				normalized = append(normalized, next)
				stack = append(stack, entry{child, next, false})
			}
			item.out["combinator"], item.out["rules"] = x["combinator"], normalized
		} else {
			if len(x) != 3 {
				return invalid()
			}
			for k := range x {
				if k != "field" && k != "operator" && k != "value" {
					return invalid()
				}
			}
			field, operator := str(x, "field"), str(x, "operator")
			valid := false
			switch field {
			case "keywordList", "domainList":
				id, ok := x["value"].(string)
				u, e := uuid.Parse(id)
				valid = ok && operator == "matches" && e == nil && strings.EqualFold(id, u.String()) && (u == uuid.Nil || strings.EqualFold(id, "ffffffff-ffff-ffff-ffff-ffffffffffff") || u.Variant() == uuid.RFC4122 && u.Version() >= 1 && u.Version() <= 8)
			case "accountTier", "subjectType":
				v, ok := x["value"].(string)
				valid = ok && (operator == "eq" || operator == "neq") && (field == "accountTier" && (v == "new" || v == "normal") || field == "subjectType" && (v == "person" || v == "agent" || v == "organization"))
			case "textLength", "linkCount", "attachmentCount", "fileBytes":
				valid = conditionInteger(x["value"]) && (operator == "eq" || operator == "neq" || operator == "gt" || operator == "gte" || operator == "lt" || operator == "lte")
			}
			if !valid {
				return invalid()
			}
			item.out["field"], item.out["operator"], item.out["value"] = x["field"], x["operator"], x["value"]
		}
	}
	return out, nil
}
func conditionInteger(v any) bool {
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
	return !math.IsNaN(n) && n >= 0 && n <= 9007199254740991 && n == math.Trunc(n)
}
