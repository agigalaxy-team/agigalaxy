package chat

import (
	"encoding/json"
	"regexp"
	"unicode/utf8"
)

var reportUUID = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var reportCategories = []string{"advertising", "harassment", "privacy", "misrepresentation", "other"}
var reportStates = []string{"received", "reviewing", "resolved", "appealed", "withdrawn"}

func reportInvalid() error      { return fail("invalid_chat_report_request", 400) }
func reportPositive(v any) bool { return num(Object{"n": v}, "n") > 0 && reportInteger(v) }
func reportInteger(v any) bool {
	switch n := v.(type) {
	case json.Number:
		i, e := n.Int64()
		return e == nil && i <= 9007199254740991
	case int:
		return true
	case int64:
		return true
	case float64:
		return n == float64(int64(n)) && n <= 9007199254740991
	default:
		return false
	}
}
func reportText(x Object, k string, max int) bool {
	v, ok := x[k].(string)
	v = trim(v)
	if !ok || utf8.RuneCountInString(v) < 1 || utf8.RuneCountInString(v) > max {
		return false
	}
	x[k] = v
	return true
}
func reportID(x Object, k string) bool { return reportUUID.MatchString(str(x, k)) }
func reportMaterials(v any) ([]any, error) {
	a, ok := v.([]any)
	if !ok || len(a) > 20 {
		return nil, reportInvalid()
	}
	seen := map[string]bool{}
	for _, i := range a {
		o, ok := i.(map[string]any)
		if !ok || !strict(o, "messageId", "revision", "attachmentIds") || !reportID(o, "messageId") || !reportPositive(o["revision"]) || seen[str(o, "messageId")] {
			return nil, reportInvalid()
		}
		seen[str(o, "messageId")] = true
		if _, ok := o["attachmentIds"]; !ok {
			o["attachmentIds"] = []any{}
		}
		ids, ok := o["attachmentIds"].([]any)
		if !ok || len(ids) > 16 {
			return nil, reportInvalid()
		}
		ss := map[string]bool{}
		for _, id := range ids {
			s, ok := id.(string)
			if !ok || !reportUUID.MatchString(s) || ss[s] {
				return nil, reportInvalid()
			}
			ss[s] = true
		}
	}
	return a, nil
}
func reportScopes(x Object) bool {
	a, ok := x["scopes"].([]any)
	if !ok || len(a) < 1 || len(a) > 2 || !reportPositive(x["until"]) {
		return false
	}
	seen := map[string]bool{}
	for _, v := range a {
		s, ok := v.(string)
		if !ok || !has([]string{"sending-paused", "invitations-paused"}, s) || seen[s] {
			return false
		}
		seen[s] = true
	}
	return true
}
func parseReport(x Object, event bool) (Object, error) {
	keys := []string{"operationId", "roomId", "roomVersion", "category", "summary", "materials"}
	if event {
		keys = []string{"operationId", "reportId", "expectedVersion", "summary", "kind", "materials"}
		switch str(x, "kind") {
		case "pause":
			keys = []string{"operationId", "reportId", "expectedVersion", "summary", "kind", "targetVersion", "rule", "scopes", "until"}
		case "resolve":
			keys = []string{"operationId", "reportId", "expectedVersion", "summary", "kind", "targetVersion", "rule", "verdict", "restriction"}
		case "supplement", "appeal", "withdraw-report", "review", "resume":
		default:
			return nil, reportInvalid()
		}
	}
	if !strict(x, keys...) || !reportID(x, "operationId") || !reportText(x, "summary", 1600) {
		return nil, reportInvalid()
	}
	if event {
		if !reportID(x, "reportId") || !reportPositive(x["expectedVersion"]) {
			return nil, reportInvalid()
		}
		if has([]string{"pause", "resolve"}, str(x, "kind")) {
			if !reportPositive(x["targetVersion"]) || !reportText(x, "rule", 120) {
				return nil, reportInvalid()
			}
			if str(x, "kind") == "pause" && !reportScopes(x) {
				return nil, reportInvalid()
			}
			if str(x, "kind") == "resolve" {
				if !has([]string{"upheld", "dismissed"}, str(x, "verdict")) {
					return nil, reportInvalid()
				}
				v, exists := x["restriction"]
				if !exists {
					return nil, reportInvalid()
				}
				if v != nil {
					r, ok := v.(map[string]any)
					if !ok || !strict(r, "scopes", "until") || !reportScopes(r) {
						return nil, reportInvalid()
					}
				}
			}
		}
	} else {
		if !reportID(x, "roomId") || !reportPositive(x["roomVersion"]) || !has(reportCategories, str(x, "category")) {
			return nil, reportInvalid()
		}
		if _, ok := x["materials"]; !ok {
			x["materials"] = []any{}
		}
	}
	if v, exists := x["materials"]; exists {
		if _, e := reportMaterials(v); e != nil {
			return nil, e
		}
	}
	return x, nil
}
func parseReportQuery(x Object) (Object, error) {
	if !strict(x, "roomId", "state", "after", "limit") {
		return nil, reportInvalid()
	}
	for _, k := range []string{"roomId", "after"} {
		if _, ok := x[k]; ok && !reportID(x, k) {
			return nil, reportInvalid()
		}
	}
	if _, ok := x["state"]; ok && !has(reportStates, str(x, "state")) {
		return nil, reportInvalid()
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(20)
	}
	if !reportInteger(x["limit"]) || num(x, "limit") < 1 || num(x, "limit") > 50 {
		return nil, reportInvalid()
	}
	return x, nil
}

func reportStrings(v any) []string {
	a := []string{}
	switch vv := v.(type) {
	case []string:
		for _, s := range vv {
			if !has(a, s) {
				a = append(a, s)
			}
		}
	case []any:
		for _, item := range vv {
			if s, ok := item.(string); ok && !has(a, s) {
				a = append(a, s)
			}
		}
	}
	return a
}
