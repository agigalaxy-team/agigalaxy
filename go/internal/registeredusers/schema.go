package registeredusers

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"math"
	"regexp"
	"time"
	"unicode/utf8"
)

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var afterPattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
var CommandActions = map[string]string{"password-reset": "accounts.password.reset", "login-disable": "accounts.login.disable", "login-restore": "accounts.login.restore", "sessions-revoke": "accounts.sessions.revoke", "profile-correct": "accounts.profile.correct", "profile-preset": "accounts.profile.correct"}
var ListQuery = []string{"page", "pageSize", "query", "source", "business", "subjectType", "login", "emailVerified", "participation", "registeredFrom", "registeredTo", "sort"}

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
		if !has(required, k) && !has(optional, k) {
			return false
		}
	}
	return true
}
func cloneObject(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func bounded(v any, min, max int, doTrim bool) (string, bool) {
	s, ok := v.(string)
	if doTrim {
		s = trim(s)
	}
	n := utf8.RuneCountInString(s)
	return s, ok && n >= min && n <= max
}
func whole(v any, min, max int64) bool {
	switch n := v.(type) {
	case int:
		return int64(n) >= min && int64(n) <= max
	case int64:
		return n >= min && n <= max
	case float64:
		return !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= float64(max)
	case json.Number:
		f, e := n.Float64()
		return e == nil && !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f) && f >= float64(min) && f <= float64(max)
	}
	return false
}
func parseText(o Object, key string, min, max int, doTrim bool) bool {
	s, ok := bounded(o[key], min, max, doTrim)
	if ok {
		o[key] = s
	}
	return ok
}

func ParseList(input Object) (Object, error) {
	if !closed(input, nil, ListQuery) {
		return nil, invalid()
	}
	x := cloneObject(input)
	for k, v := range map[string]any{"page": 1, "pageSize": 20, "source": "all", "sort": "registered-desc"} {
		if _, ok := x[k]; !ok {
			x[k] = v
		}
	}
	if !whole(x["page"], 1, 1000000) || !whole(x["pageSize"], 20, 100) || !has([]string{"20", "50", "100"}, numberString(x["pageSize"])) {
		return nil, invalid()
	}
	for k, choices := range map[string][]string{"source": {"all", "registered", "business-only"}, "business": {"formed", "not-formed"}, "subjectType": {"person", "organization", "agent", "unknown"}, "login": {"enabled", "disabled"}, "emailVerified": {"yes", "no"}, "participation": {"restricted", "unrestricted"}, "sort": {"registered-desc", "registered-asc"}} {
		if v, ok := x[k]; ok && !has(choices, str(v)) {
			return nil, invalid()
		}
	}
	if _, ok := x["query"]; ok && !parseText(x, "query", 1, 320, true) {
		return nil, invalid()
	}
	dates := map[string]time.Time{}
	for _, k := range []string{"registeredFrom", "registeredTo"} {
		if v, ok := x[k]; ok {
			t, e := time.Parse(time.RFC3339Nano, str(v))
			if e != nil || !isoPattern.MatchString(str(v)) {
				return nil, invalid()
			}
			dates[k] = t
		}
	}
	if a, ok := dates["registeredFrom"]; ok {
		if b, ok := dates["registeredTo"]; ok && a.After(b) {
			return nil, invalid()
		}
	}
	return x, nil
}

var isoPattern = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$`)

func numberString(v any) string { b, _ := json.Marshal(v); return string(b) }
func ParseHistory(input Object) (Object, error) {
	if !closed(input, nil, []string{"after", "limit"}) {
		return nil, invalid()
	}
	x := cloneObject(input)
	if _, ok := x["limit"]; !ok {
		x["limit"] = 20
	}
	if !whole(x["limit"], 1, 100) {
		return nil, invalid()
	}
	if v, ok := x["after"]; ok && !afterPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	return x, nil
}
func ParseCommand(input Object) (Object, error) {
	x := cloneObject(input)
	kind := str(x["kind"])
	if CommandActions[kind] == "" {
		return nil, invalid()
	}
	required := []string{"operationId", "expectedVersion", "reason", "kind"}
	optional := []string{}
	if kind == "profile-correct" {
		required = append(required, "displayName", "basis", "expectedProfileRevision")
		optional = []string{"avatarKey", "bio"}
	}
	if kind == "profile-preset" {
		required = append(required, "basis", "expectedPresetRevision")
		optional = []string{"displayName", "avatarKey", "bio"}
	}
	if !closed(x, required, optional) || !uuidPattern.MatchString(str(x["operationId"])) || !hashPattern.MatchString(str(x["expectedVersion"])) || !parseText(x, "reason", 1, 1000, true) {
		return nil, invalid()
	}
	if kind == "profile-correct" || kind == "profile-preset" {
		if !parseText(x, "basis", 1, 1000, true) {
			return nil, invalid()
		}
		revision := "expectedProfileRevision"
		if kind == "profile-preset" {
			revision = "expectedPresetRevision"
		}
		if !whole(x[revision], 0, 9007199254740991) {
			return nil, invalid()
		}
		if _, ok := x["displayName"]; ok && !parseText(x, "displayName", 1, 120, true) {
			return nil, invalid()
		}
		if v, ok := x["avatarKey"]; ok && !accounts.ValidAvatarKey(v) {
			return nil, invalid()
		}
		if _, ok := x["bio"]; ok && !parseText(x, "bio", 0, 500, true) {
			return nil, invalid()
		}
	}
	return x, nil
}
