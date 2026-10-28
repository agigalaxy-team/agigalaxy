package maintenance

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"
)

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var regexpMaintenanceCode = regexp.MustCompile(`^maintenance_[a-z_]{1,80}$`)
var pointPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var regexpBefore = regexp.MustCompile(`^[0-9]{16,20}$`)
var cursorPattern = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
var componentPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func closed(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		if !includes(required, k) && !includes(optional, k) {
			return false
		}
	}
	return true
}
func jsNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case nil:
		return 0, true
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	case json.Number:
		f, e := n.Float64()
		return f, e == nil
	case string:
		s := trim(n)
		if s == "" {
			return 0, true
		}
		if len(s) > 2 && (s[:2] == "0x" || s[:2] == "0X" || s[:2] == "0b" || s[:2] == "0B" || s[:2] == "0o" || s[:2] == "0O") {
			i, e := strconv.ParseUint(s, 0, 64)
			return float64(i), e == nil
		}
		f, e := strconv.ParseFloat(s, 64)
		return f, e == nil
	case []any:
		if len(n) == 0 {
			return 0, true
		}
		if len(n) == 1 {
			return jsNumber(n[0])
		}
	}
	return math.NaN(), false
}
func isoDate(v any) bool {
	s, ok := v.(string)
	if !ok || !regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$`).MatchString(s) {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, s)
	return e == nil
}
func ParseQuery(kind string, input Object) (Object, error) {
	optional := []string{"after", "limit"}
	limit := 50
	if kind == "logs" {
		optional = []string{"component", "level", "period", "before", "limit"}
	} else if !includes([]string{"backups", "plans", "page"}, kind) {
		return nil, invalid()
	} else {
		limit = 25
	}
	if !closed(input, nil, optional) {
		return nil, invalid()
	}
	x := clone(input)
	if v, ok := x["limit"]; ok {
		f, valid := jsNumber(v)
		if !valid || !whole(f, 1, 100) {
			return nil, invalid()
		}
		x["limit"] = f
	} else {
		x["limit"] = limit
	}
	if v, ok := x["after"]; ok {
		valid := kind == "backups" && pointPattern.MatchString(str(v)) || kind == "plans" && uuidPattern.MatchString(str(v)) || kind == "page" && cursorPattern.MatchString(str(v))
		if !valid {
			return nil, invalid()
		}
	}
	if kind == "logs" {
		for k, def := range map[string]string{"level": "all", "period": "1h"} {
			if _, ok := x[k]; !ok {
				x[k] = def
			}
		}
		if !includes([]string{"all", "info", "warn", "error"}, str(x["level"])) || !includes([]string{"15m", "1h", "24h"}, str(x["period"])) {
			return nil, invalid()
		}
		if v, ok := x["component"]; ok && !componentPattern.MatchString(str(v)) {
			return nil, invalid()
		}
		if v, ok := x["before"]; ok && !isoDate(v) && !regexp.MustCompile(`^[0-9]{16,20}$`).MatchString(str(v)) {
			return nil, invalid()
		}
	}
	return x, nil
}
func modules(v any, min, max int) bool {
	a, ok := v.([]any)
	if !ok {
		if b, ok := v.([]string); ok {
			a = []any{}
			for _, s := range b {
				a = append(a, s)
			}
		} else {
			return false
		}
	}
	if len(a) < min || len(a) > max {
		return false
	}
	for _, v := range a {
		if !includes(ModuleIDs(), str(v)) {
			return false
		}
	}
	return true
}
func ParseBackup(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "kind"}, []string{"pointId"}) || !uuidPattern.MatchString(str(input["operationId"])) || !includes([]string{"create", "verify"}, str(input["kind"])) {
		return nil, invalid()
	}
	_, point := input["pointId"]
	if input["kind"] == "create" && point || input["kind"] == "verify" && (!point || !pointPattern.MatchString(str(input["pointId"]))) {
		return nil, invalid()
	}
	return clone(input), nil
}
func ParseCreatePlan(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "pointId"}, []string{"scope", "moduleIds"}) || !uuidPattern.MatchString(str(input["operationId"])) || !pointPattern.MatchString(str(input["pointId"])) {
		return nil, invalid()
	}
	x := clone(input)
	if _, ok := x["scope"]; !ok {
		x["scope"] = "whole-site"
	}
	if !includes([]string{"whole-site", "selected-modules"}, str(x["scope"])) {
		return nil, invalid()
	}
	v, present := x["moduleIds"]
	if x["scope"] == "whole-site" && present || x["scope"] == "selected-modules" && !present {
		return nil, invalid()
	}
	if present {
		if !modules(v, 1, len(ModuleIDs())) {
			return nil, invalid()
		}
		seen := map[string]bool{}
		for _, id := range texts(v) {
			if seen[id] {
				return nil, invalid()
			}
			seen[id] = true
		}
	}
	return x, nil
}
func ParsePlanCommand(kind string, input Object) (Object, error) {
	required := []string{"operationId", "expectedRevision"}
	if kind == "approve" {
		required = append(required, "expectedPlanDigest", "acknowledgement")
	} else if kind != "execute" && kind != "cancel" {
		return nil, invalid()
	}
	if !closed(input, required, nil) || !uuidPattern.MatchString(str(input["operationId"])) || !whole(input["expectedRevision"], 1, 9007199254740991) {
		return nil, invalid()
	}
	if kind == "approve" {
		ack := obj(input["acknowledgement"])
		if !pointPattern.MatchString(str(input["expectedPlanDigest"])) || !closed(ack, []string{"point", "scope", "possibleLoss", "openingConditions"}, nil) {
			return nil, invalid()
		}
		for _, v := range ack {
			if v != true {
				return nil, invalid()
			}
		}
	}
	return clone(input), nil
}
func ParseNativeCommand(input Object) (Object, error) {
	kind := str(input["kind"])
	required := []string{"kind"}
	optional := []string{}
	switch kind {
	case "overview":
	case "logs":
		required = append(required, "query")
	case "catalog":
		optional = append(optional, "query")
	case "point":
		required = append(required, "pointId")
	case "backup-create":
		required = append(required, "operationId", "operatorId")
	case "backup-verify":
		required = append(required, "operationId", "operatorId", "pointId")
	case "operation":
		required = append(required, "operationId")
	case "restore-preview":
		required = append(required, "pointId", "moduleIds")
	case "restore-execute":
		required = append(required, "operationId", "operatorId", "planId", "revision", "planDigest", "approvedAt", "pointId", "moduleIds", "openingConditions", "footprintDigest")
	default:
		return nil, invalid()
	}
	if !closed(input, required, optional) {
		return nil, invalid()
	}
	x := clone(input)
	for _, k := range []string{"operationId", "planId"} {
		if v, ok := x[k]; ok && !uuidPattern.MatchString(str(v)) {
			return nil, invalid()
		}
	}
	for _, k := range []string{"pointId", "planDigest", "footprintDigest"} {
		if v, ok := x[k]; ok && !pointPattern.MatchString(str(v)) {
			return nil, invalid()
		}
	}
	if v, ok := x["operatorId"]; ok {
		value, valid := v.(string)
		if !valid || utf8.RuneCountInString(value) < 1 || utf8.RuneCountInString(value) > 500 {
			return nil, invalid()
		}
	}
	if v, ok := x["revision"]; ok && !whole(v, 1, 9007199254740991) {
		return nil, invalid()
	}
	if v, ok := x["approvedAt"]; ok && !isoDate(v) {
		return nil, invalid()
	}
	if v, ok := x["moduleIds"]; ok && !modules(v, 1, len(ModuleIDs())) {
		return nil, invalid()
	}
	if v, ok := x["openingConditions"]; ok {
		a := list(v)
		if len(a) != len(OpeningConditions()) {
			return nil, invalid()
		}
		for _, v := range a {
			if !includes(OpeningConditions(), str(v)) {
				return nil, invalid()
			}
		}
	}
	if v, ok := x["query"]; ok {
		queryKind := "backups"
		if kind == "logs" {
			queryKind = "logs"
		}
		q, e := ParseQuery(queryKind, obj(v))
		if e != nil {
			return nil, e
		}
		x["query"] = q
	}
	return x, nil
}
