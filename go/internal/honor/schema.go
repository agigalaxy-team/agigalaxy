package honor

import (
	"encoding/json"
	"math"
	"regexp"
)

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var uuidPattern = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func closed(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	allowed := map[string]bool{}
	for _, key := range required {
		if _, ok := o[key]; !ok {
			return false
		}
		allowed[key] = true
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key := range o {
		if !allowed[key] {
			return false
		}
	}
	return true
}
func integer(v any, min, max int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= max
	case int64:
		return n >= min && n <= max
	case float64:
		return n >= float64(min) && n <= float64(max) && math.Trunc(n) == n
	case json.Number:
		f, e := n.Float64()
		return e == nil && f >= float64(min) && f <= float64(max) && math.Trunc(f) == f
	}
	return false
}
func exactOne(v any) bool { return integer(v, 1, 1) }
func parseRanking(input Object) (Object, error) {
	if !closed(input, []string{"ruleId", "ruleVersion"}, nil) || !ruleIDPattern.MatchString(str(input, "ruleId")) || !ruleVersionPattern.MatchString(str(input, "ruleVersion")) {
		return nil, fail("invalid_honor_ranking", 400)
	}
	return input, nil
}
func parseQuery(input Object, v2 bool) (Object, error) {
	optional := []string{"limit", "after", "proofAfter", "riskAfter", "sourceId", "sourceAfter", "riskIndex", "riskReferenceAfter", "expectedFingerprint"}
	if v2 {
		optional = []string{"after", "limit", "expectedFingerprint", "includeSimulation"}
	}
	if !closed(input, []string{"ruleId", "ruleVersion", "subjectId"}, optional) || !ruleIDPattern.MatchString(str(input, "ruleId")) || !ruleVersionPattern.MatchString(str(input, "ruleVersion")) || !subjectPattern.MatchString(str(input, "subjectId")) {
		return nil, fail("invalid_honor_query", 400)
	}
	q := clone(input).(Object)
	if v, ok := q["limit"]; ok {
		if !integer(v, 1, 20) {
			return nil, fail("invalid_honor_query", 400)
		}
	} else if v2 {
		q["limit"] = 8
	}
	if v, ok := q["expectedFingerprint"]; ok {
		if _, ok := v.(string); !ok || !hashPattern.MatchString(text(v)) {
			return nil, fail("invalid_honor_query", 400)
		}
	}
	if v2 {
		if v, ok := q["after"]; ok {
			if _, ok := v.(string); !ok || !hashPattern.MatchString(text(v)) {
				return nil, fail("invalid_honor_query", 400)
			}
		}
		if v, ok := q["includeSimulation"]; ok {
			if _, ok := v.(bool); !ok {
				return nil, fail("invalid_honor_query", 400)
			}
		} else {
			q["includeSimulation"] = false
		}
		return q, nil
	}
	for _, key := range []string{"after", "proofAfter", "sourceId"} {
		if v, ok := q[key]; ok {
			if _, ok := v.(string); !ok || !uuidPattern.MatchString(text(v)) {
				return nil, fail("invalid_honor_query", 400)
			}
		}
	}
	for _, key := range []string{"riskAfter", "sourceAfter", "riskIndex", "riskReferenceAfter"} {
		if v, ok := q[key]; ok && !integer(v, 0, 9007199254740991) {
			return nil, fail("invalid_honor_query", 400)
		}
	}
	return q, nil
}
