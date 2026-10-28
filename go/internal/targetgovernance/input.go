package targetgovernance

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"unicode/utf8"
)

func strict(x Object, keys ...string) bool {
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
func integer(v any) (int64, bool) {
	var n float64
	switch x := v.(type) {
	case json.Number:
		n, _ = x.Float64()
	case float64:
		n = x
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	default:
		return 0, false
	}
	return int64(n), !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && n > 0 && n <= 9007199254740991
}
func trim(s string) string {
	r := []rune(s)
	space := func(c rune) bool {
		return c >= 9 && c <= 13 || c == 32 || c == 0xa0 || c == 0x1680 || c >= 0x2000 && c <= 0x200a || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff
	}
	i, j := 0, len(r)
	for i < j && space(r[i]) {
		i++
	}
	for j > i && space(r[j-1]) {
		j--
	}
	return string(r[i:j])
}
func invalid() error { return fail("invalid_target_governance", 400) }
func text(x Object, k string, max int) bool {
	v, ok := x[k].(string)
	v = trim(v)
	x[k] = v
	return ok && v != "" && utf8.RuneCountInString(v) <= max
}
func validTarget(x Object, version bool) bool {
	if x == nil || !has([]string{"task", "room"}, str(x, "type")) || !opportunities.UUID.MatchString(str(x, "id")) {
		return false
	}
	if !version {
		return strict(x, "type", "id")
	}
	n, ok := integer(x["version"])
	if !ok {
		return false
	}
	x["version"] = n
	if x["type"] == "room" {
		return strict(x, "type", "id", "version")
	}
	return strict(x, "type", "id", "version", "rootEventId") && opportunities.UUID.MatchString(str(x, "rootEventId"))
}
func restriction(x Object) bool {
	if x == nil || !strict(x, "scopes", "until") {
		return false
	}
	n, ok := integer(x["until"])
	if !ok {
		return false
	}
	x["until"] = n
	a, ok := x["scopes"].([]any)
	if !ok || len(a) < 1 || len(a) > 2 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range a {
		s, ok := v.(string)
		if !ok || !has([]string{"discovery-hidden", "new-participation-paused", "sending-paused", "invitations-paused"}, s) || seen[s] {
			return false
		}
		seen[s] = true
	}
	return true
}
func ParsePayload(raw []byte, report bool) (Object, error) {
	var x Object
	if protocol.Decode(raw, &x) != nil || x == nil || num(x, "schemaVersion") != 2 || !opportunities.UUID.MatchString(str(x, "id")) || !text(x, "summary", 1600) {
		return nil, invalid()
	}
	if report {
		if !strict(x, "schemaVersion", "id", "target", "category", "summary") || !validTarget(obj(x, "target"), true) || !has([]string{"advertising", "harassment", "privacy", "misrepresentation", "other"}, str(x, "category")) {
			return nil, invalid()
		}
		return x, nil
	}
	n, ok := integer(x["expectedVersion"])
	if !ok || !opportunities.UUID.MatchString(str(x, "reportId")) {
		return nil, invalid()
	}
	x["expectedVersion"] = n
	common := []string{"schemaVersion", "id", "reportId", "expectedVersion", "summary", "kind"}
	switch str(x, "kind") {
	case "supplement", "appeal", "withdraw-report", "resume", "review":
		if !strict(x, common...) {
			return nil, invalid()
		}
	case "pause":
		if !strict(x, append(common, "scopes", "until", "targetVersion", "rule")...) || !restriction(Object{"scopes": x["scopes"], "until": x["until"]}) || !text(x, "rule", 120) {
			return nil, invalid()
		}
		n, ok = integer(x["targetVersion"])
		if !ok {
			return nil, invalid()
		}
		x["targetVersion"] = n
	case "resolve":
		if !strict(x, append(common, "verdict", "rule", "targetVersion", "restriction")...) || !has([]string{"upheld", "dismissed"}, str(x, "verdict")) || !text(x, "rule", 120) {
			return nil, invalid()
		}
		if _, exists := x["restriction"]; !exists {
			return nil, invalid()
		}
		if x["restriction"] != nil && !restriction(obj(x, "restriction")) {
			return nil, invalid()
		}
		n, ok = integer(x["targetVersion"])
		if !ok {
			return nil, invalid()
		}
		x["targetVersion"] = n
	default:
		return nil, invalid()
	}
	return x, nil
}
