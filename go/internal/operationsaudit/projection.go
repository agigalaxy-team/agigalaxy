// Package operationsaudit reads the retained business audit ledger. Its closed
// DTO projection never exposes arbitrary stored selection/result prose.
package operationsaudit

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Object = map[string]any

//go:embed shapes.json
var shapeJSON []byte
var catalog struct {
	Types        []Object                             `json:"types"`
	Actions      map[string]map[string]map[string]int `json:"actions"`
	Attribution  Object                               `json:"attribution"`
	ActorContext Object                               `json:"actorContext"`
}

func init() {
	if e := protocol.Decode(shapeJSON, &catalog); e != nil {
		panic(e)
	}
}
func obj(v any) Object { o, _ := v.(map[string]any); return o }
func str(v any) string { s, _ := v.(string); return s }
func numeric(v any) (float64, bool) {
	var f float64
	switch x := v.(type) {
	case float64:
		f = x
	case int64:
		f = float64(x)
	case int:
		f = float64(x)
	case json.Number:
		var e error
		f, e = x.Float64()
		if e != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return f, !math.IsInf(f, 0) && !math.IsNaN(f)
}
func matchPattern(pattern, value string) bool {
	r, e := regexp.Compile(pattern)
	return e == nil && r.MatchString(value)
}
func validate(v any, s Object) (any, bool) {
	if types, ok := s["type"].([]any); ok {
		for _, kind := range types {
			one := Object{}
			for k, v := range s {
				one[k] = v
			}
			one["type"] = kind
			if value, ok := validate(v, one); ok {
				return value, true
			}
		}
		return nil, false
	}
	if options, ok := s["anyOf"].([]any); ok {
		for _, option := range options {
			if value, ok := validate(v, obj(option)); ok {
				return value, true
			}
		}
		return nil, false
	}
	if constant, present := s["const"]; present {
		x, _ := protocol.EncodeJS([]any{constant})
		y, e := protocol.EncodeJS([]any{v})
		return v, e == nil && bytes.Equal(x, y)
	}
	switch s["type"] {
	case "null":
		return nil, v == nil
	case "boolean":
		_, ok := v.(bool)
		return v, ok
	case "integer", "number":
		n, ok := numeric(v)
		if !ok {
			return nil, false
		}
		if s["type"] == "integer" && (math.Trunc(n) != n || math.Abs(n) > 9007199254740991) {
			return nil, false
		}
		if min, ok := numeric(s["minimum"]); ok && n < min {
			return nil, false
		}
		if max, ok := numeric(s["maximum"]); ok && n > max {
			return nil, false
		}
		if min, ok := numeric(s["exclusiveMinimum"]); ok && n <= min {
			return nil, false
		}
		return n, true
	case "string":
		text, ok := v.(string)
		if !ok {
			return nil, false
		}
		length := utf8.RuneCountInString(text)
		if min, ok := numeric(s["minLength"]); ok && float64(length) < min {
			return nil, false
		}
		if max, ok := numeric(s["maxLength"]); ok && float64(length) > max {
			return nil, false
		}
		if pattern := str(s["pattern"]); pattern != "" && !matchPattern(pattern, text) {
			return nil, false
		}
		if s["format"] == "date" && (strings.HasPrefix(text, "0000-") || !validDay(text)) {
			return nil, false
		}
		if max, _ := numeric(s["maxLength"]); max == 512 && !validFileVersion(text) {
			return nil, false
		}
		return text, true
	case "array":
		a, ok := v.([]any)
		if !ok {
			return nil, false
		}
		if max, ok := numeric(s["maxItems"]); ok && float64(len(a)) > max {
			return nil, false
		}
		result := []any{}
		for _, value := range a {
			x, ok := validate(value, obj(s["items"]))
			if !ok {
				return nil, false
			}
			result = append(result, x)
		}
		return result, true
	case "object":
		o, ok := v.(map[string]any)
		if !ok || o == nil {
			return nil, false
		}
		properties := obj(s["properties"])
		if required, ok := s["required"].([]any); ok {
			for _, key := range required {
				if _, present := o[str(key)]; !present {
					return nil, false
				}
			}
		}
		result := Object{}
		for key, value := range o {
			schema, present := properties[key]
			if !present {
				if s["additionalProperties"] == false {
					return nil, false
				}
				continue
			}
			x, ok := validate(value, obj(schema))
			if !ok {
				return nil, false
			}
			result[key] = x
		}
		return result, true
	}
	return nil, false
}
func validDay(value string) bool { _, e := time.Parse("2006-01-02", value); return e == nil }
func validFileVersion(value string) bool {
	var a []any
	if protocol.Decode([]byte(value), &a) != nil || len(a) != 9 {
		return false
	}
	if !slices.Contains([]string{"prepared", "uploading", "scan-pending", "scanning", "available", "blocked", "erased", "expired", "revoked"}, str(a[0])) {
		return false
	}
	for _, i := range []int{1, 8} {
		n, ok := numeric(a[i])
		if !ok || n < 0 || n > 9007199254740991 || math.Trunc(n) != n {
			return false
		}
	}
	if _, ok := a[4].(bool); !ok {
		return false
	}
	for _, i := range []int{2, 5, 6, 7} {
		if a[i] != nil && !validFormat(a[i], "date-time") {
			return false
		}
	}
	return a[3] == nil || validFormat(a[3], "uuid")
}
func validFormat(v any, format string) bool {
	for _, schema := range catalog.Types {
		if schema["format"] == format {
			_, ok := validate(v, schema)
			return ok
		}
	}
	return false
}
func project(value any, fields map[string]int) Object {
	o := obj(value)
	result := Object{}
	for key, index := range fields {
		if value, present := o[key]; present {
			x, ok := validate(value, catalog.Types[index])
			if ok {
				result[key] = x
			}
		}
	}
	return result
}
func trim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r == '\ufeff' || strings.ContainsRune(" \t\r\n\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000", r)
	})
}
func stamp(v any) any {
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case string:
		if parsed, e := time.Parse(time.RFC3339Nano, t); e == nil {
			return parsed.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	return nil
}
func baseAttribution(row Object) Object {
	human := row["actor_kind"] == "business-operator"
	var ai any
	if row["actor_kind"] == "operations-ai-service" && strings.HasPrefix(str(row["operator_id"]), "ai:") && validFormat(strings.TrimPrefix(str(row["operator_id"]), "ai:"), "uuid") {
		ai = strings.TrimPrefix(str(row["operator_id"]), "ai:")
	}
	initiator, decision, basis := "unknown", "unknown", "not-recorded"
	var person, name, grant any
	if human {
		initiator, decision, basis = "human", "human", "authenticated-human"
		person = row["operator_id"]
		name = cleanName(row["operator_display_name"])
	}
	if validFormat(row["grant_id"], "uuid") {
		grant = row["grant_id"]
	}
	return Object{"schemaVersion": 1, "aiAccountId": ai, "aiAccountName": nil, "domain": nil, "initiatorKind": initiator, "initiatorOperatorId": person, "initiatorDisplayName": name, "decisionSource": decision, "decisionBasis": basis, "taskId": nil, "taskSource": nil, "taskReadable": false, "cardId": nil, "planId": nil, "planVersion": nil, "grantId": grant, "grantVersion": nil, "strategyId": nil, "strategyVersionId": nil}
}
func cleanName(v any) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	s = trim(s)
	if s == "" || protocol.TextLength(s) > 120 {
		return nil
	}
	return s
}

// Metadata preserves the original ledger identifiers and only fields accepted
// by the retained per-action DTO catalog. It does not mutate historical rows.
func Metadata(row Object) Object {
	fields := catalog.Actions[str(row["action"])]
	selection, result := Object{}, Object{}
	if fields != nil {
		selection = project(row["selection"], fields["selection"])
		result = project(row["result"], fields["result"])
	}
	human, ai := row["actor_kind"] == "business-operator", row["actor_kind"] == "operations-ai-service"
	executor := row["actor_kind"] == "operations-executor" && validFormat(row["execution_id"], "uuid") && validFormat(row["grant_id"], "uuid")
	kind := "unknown"
	var role, name, execution, grant any
	if human {
		kind = "business-operator"
		role = row["operator_role"]
		if s, ok := row["operator_display_name"].(string); ok && trim(s) != "" {
			name = trim(s)
		}
	} else if ai {
		kind = "operations-ai-service"
	} else if executor {
		kind = "operations-executor"
		execution = row["execution_id"]
	}
	if (executor || ai) && validFormat(row["grant_id"], "uuid") {
		grant = row["grant_id"]
	}
	attribution, ok := validate(row["audit_attribution"], catalog.Attribution)
	if !ok {
		attribution = baseAttribution(row)
	}
	sequence := fmt.Sprint(row["sequence"])
	return Object{"id": row["id"], "sequence": sequence, "operatorId": row["operator_id"], "operatorDisplayName": name, "operatorRole": role, "action": row["action"], "actorKind": kind, "executionId": execution, "grantId": grant, "attribution": attribution, "accountId": row["account_id"], "operationId": row["operation_id"], "httpRequestId": row["http_request_id"], "selection": selection, "result": result, "createdAt": stamp(row["created_at"])}
}
