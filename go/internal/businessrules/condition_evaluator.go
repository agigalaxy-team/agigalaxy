package businessrules

import (
	"fmt"
	"strings"
)

type conditionEnvironment struct {
	Count     int
	Lists     map[string]Object
	HasText   bool
	Text      string
	Hosts     []string
	LinkCount *int64
	Facts     Object
	Trace     map[string]Object
}

// EvaluateCondition retains the original three-valued trace for the current
// supplied facts. Numeric strategy leaves use facts directly; list predicates
// still require their owning policy context and cannot silently match.
func EvaluateCondition(value, facts Object) (Object, error) {
	parsed, e := ParseCondition(value)
	if e != nil {
		return nil, e
	}
	environment := &conditionEnvironment{Facts: facts, Trace: map[string]Object{}}
	_, e = environment.evaluate(parsed, 0, "1")
	if e != nil {
		return nil, e
	}
	return environment.Trace["1"], nil
}
func (c *conditionEnvironment) evaluate(node Object, depth int, path string) (state string, err error) {
	defer func() {
		if err == nil && c.Trace != nil {
			trace := Object{"path": path, "kind": "condition", "field": node["field"], "operator": node["operator"], "value": node["value"], "state": state}
			if children, ok := objects(node["rules"]); ok {
				traces := []Object{}
				for i := range children {
					traces = append(traces, c.Trace[fmt.Sprintf("%s.%d", path, i+1)])
				}
				trace = Object{"path": path, "kind": "group", "combinator": node["combinator"], "state": state, "children": traces}
			}
			c.Trace[path] = trace
		}
	}()
	c.Count++
	if node == nil || depth > 6 || c.Count > 1000 {
		return "", fail("invalid_operations_rule_request", 400)
	}
	if children, present := node["rules"]; present {
		rr, ok := objects(children)
		if !ok || len(rr) < 1 || len(rr) > 20 || str(node, "combinator") != "and" && str(node, "combinator") != "or" {
			return "", fail("invalid_operations_rule_request", 400)
		}
		hit, miss, unknown := false, false, false
		for i, child := range rr {
			state, e := c.evaluate(child, depth+1, fmt.Sprintf("%s.%d", path, i+1))
			if e != nil {
				return "", e
			}
			hit = hit || state == "hit"
			miss = miss || state == "miss"
			unknown = unknown || state == "unknown"
		}
		if str(node, "combinator") == "and" {
			if miss {
				return "miss", nil
			}
			if unknown {
				return "unknown", nil
			}
			return "hit", nil
		}
		if hit {
			return "hit", nil
		}
		if unknown {
			return "unknown", nil
		}
		return "miss", nil
	}
	field, operator := str(node, "field"), str(node, "operator")
	matched := false
	if field == "keywordList" || field == "domainList" {
		list := c.Lists[str(node, "value")]
		if list == nil || operator != "matches" {
			return "", fail("invalid_operations_rule_request", 400)
		}
		if !truth(list, "enabled") {
			return "miss", nil
		}
		if field == "keywordList" && !c.HasText {
			return "unknown", nil
		}
		entries, ok := list["entries"].([]any)
		if !ok {
			return "", fail("invalid_operations_rule_request", 400)
		}
		if field == "domainList" && c.LinkCount == nil {
			return "unknown", nil
		}
		for _, entry := range entries {
			value, ok := entry.(string)
			if !ok {
				return "", fail("invalid_operations_rule_request", 400)
			}
			if field == "keywordList" {
				matched = matched || strings.Contains(normalizeKeyword(c.Text), normalizeKeyword(value))
			} else {
				host := domain(value)
				if host == "" {
					return "", fail("invalid_operations_rule_request", 400)
				}
				for _, candidate := range c.Hosts {
					matched = matched || candidate == host || strings.HasSuffix(candidate, "."+host)
				}
			}
		}
	} else {
		actual, present := c.Facts[field]
		if !present || actual == nil {
			return "unknown", nil
		}
		if field == "accountTier" || field == "subjectType" {
			if operator != "eq" && operator != "neq" {
				return "", fail("invalid_operations_rule_request", 400)
			}
			matched = actual == node["value"]
			if operator == "neq" {
				matched = !matched
			}
		} else {
			a, b := int64Number(actual), num(node, "value")
			switch operator {
			case "eq":
				matched = a == b
			case "neq":
				matched = a != b
			case "gt":
				matched = a > b
			case "gte":
				matched = a >= b
			case "lt":
				matched = a < b
			case "lte":
				matched = a <= b
			default:
				return "", fail("invalid_operations_rule_request", 400)
			}
		}
	}
	if matched {
		return "hit", nil
	}
	return "miss", nil
}
