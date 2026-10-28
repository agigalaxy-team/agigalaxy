package managementaccounts

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var operatorPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
var afterPattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

// The active source Zod email default, without transport or SMTP assumptions.
var emailPattern = regexp.MustCompile(`(?i)^[A-Z0-9_'+\-.]*[A-Z0-9_+\-]@[A-Z0-9][A-Z0-9\-]*(?:\.[A-Z0-9][A-Z0-9\-]*)*\.[A-Z]{2,}$`)
var commandActions = map[string]string{"profile-update": "management.accounts.profile.write", "login-disable": "management.accounts.login.disable", "login-restore": "management.accounts.login.restore", "password-reset": "management.accounts.password.reset", "sessions-revoke": "management.accounts.sessions.revoke", "delete": "management.accounts.delete", "admission-change": "management.accounts.read", "email-change": "management.accounts.profile.write"}

func invalid() error { return fault.New("invalid_management_accounts_request", 400) }
func includes(list []string, k string) bool {
	for _, v := range list {
		if k == v {
			return true
		}
	}
	return false
}
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
func cloneObject(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
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
		i, e := n.Int64()
		return e == nil && i >= min && i <= max
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
func defaultText(o Object, key string, max int) bool {
	if _, ok := o[key]; !ok {
		o[key] = ""
	}
	return parseText(o, key, 0, max, true)
}
func ParseCreate(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "username", "temporaryPassword"}, []string{"firstName", "lastName", "note", "roleIds"}) || !uuidPattern.MatchString(str(input["operationId"])) {
		return nil, invalid()
	}
	o := cloneObject(input)
	if !parseText(o, "username", 1, 100, true) || !usernamePattern.MatchString(str(o["username"])) || !parseText(o, "temporaryPassword", 1, 4096, false) || !defaultText(o, "firstName", 100) || !defaultText(o, "lastName", 100) || !defaultText(o, "note", 1000) {
		return nil, invalid()
	}
	if _, ok := o["roleIds"]; !ok {
		o["roleIds"] = []any{}
	}
	roles, ok := o["roleIds"].([]any)
	if values, x := o["roleIds"].([]string); x {
		roles = []any{}
		for _, v := range values {
			roles = append(roles, v)
		}
		ok = true
	}
	if !ok || len(roles) > 100 {
		return nil, invalid()
	}
	seen := map[string]bool{}
	for _, v := range roles {
		s, ok := v.(string)
		if !ok || !uuidPattern.MatchString(s) || seen[s] {
			return nil, invalid()
		}
		seen[s] = true
	}
	o["roleIds"] = roles
	return o, nil
}
func ParseCommand(input Object) (Object, error) {
	kind := str(input["kind"])
	if commandActions[kind] == "" {
		return nil, invalid()
	}
	optional := []string{"reason"}
	switch kind {
	case "profile-update":
		optional = append(optional, "firstName", "lastName", "note")
	case "password-reset":
		optional = append(optional, "temporaryPassword")
	case "admission-change":
		optional = append(optional, "action")
	case "email-change":
		optional = append(optional, "newEmail")
	}
	if !closed(input, []string{"operationId", "expectedVersion", "kind"}, optional) || !uuidPattern.MatchString(str(input["operationId"])) || !operatorPattern.MatchString(str(input["expectedVersion"])) {
		return nil, invalid()
	}
	o := cloneObject(input)
	if !defaultText(o, "reason", 1000) {
		return nil, invalid()
	}
	switch kind {
	case "profile-update":
		found := false
		for _, k := range []string{"firstName", "lastName", "note"} {
			if _, ok := o[k]; ok {
				max := 100
				if k == "note" {
					max = 1000
				}
				if !parseText(o, k, 0, max, true) {
					return nil, invalid()
				}
				found = true
			}
		}
		if !found {
			return nil, invalid()
		}
	case "password-reset":
		if !parseText(o, "temporaryPassword", 1, 4096, false) {
			return nil, invalid()
		}
	case "admission-change":
		if o["action"] != "promote" && o["action"] != "demote" {
			return nil, invalid()
		}
	case "email-change":
		s, ok := bounded(o["newEmail"], 0, 320, false)
		if !ok || !emailPattern.MatchString(s) || strings.HasPrefix(s, ".") || strings.Contains(s, "..") {
			return nil, invalid()
		}
	}
	return o, nil
}
func ParseList(input Object) (Object, error) {
	if !closed(input, nil, []string{"page", "pageSize", "query", "enabled", "roleId", "aiDomain", "sort"}) {
		return nil, invalid()
	}
	o := cloneObject(input)
	if _, ok := o["page"]; !ok {
		o["page"] = 1
	}
	if _, ok := o["pageSize"]; !ok {
		o["pageSize"] = 20
	}
	if _, ok := o["sort"]; !ok {
		o["sort"] = "name-asc"
	}
	if !whole(o["page"], 1, 1000000) || !whole(o["pageSize"], 20, 100) || integer(o["pageSize"]) != 20 && integer(o["pageSize"]) != 50 && integer(o["pageSize"]) != 100 || !defaultText(o, "query", 200) || !includes([]string{"name-asc", "created-desc", "created-asc"}, str(o["sort"])) {
		return nil, invalid()
	}
	for _, k := range []string{"enabled", "roleId", "aiDomain"} {
		if v, ok := o[k]; ok {
			switch k {
			case "enabled":
				if v != "true" && v != "false" {
					return nil, invalid()
				}
			case "roleId":
				if !uuidPattern.MatchString(str(v)) {
					return nil, invalid()
				}
			case "aiDomain":
				if !includes([]string{"overview", "governance", "messaging", "discovery", "maintenance"}, str(v)) {
					return nil, invalid()
				}
			}
		}
	}
	return o, nil
}
func ParseHistory(input Object) (Object, error) {
	if !closed(input, nil, []string{"after", "limit"}) {
		return nil, invalid()
	}
	o := cloneObject(input)
	if _, ok := o["limit"]; !ok {
		o["limit"] = 30
	}
	if !whole(o["limit"], 1, 100) {
		return nil, invalid()
	}
	if a, ok := o["after"]; ok {
		if !afterPattern.MatchString(str(a)) {
			return nil, invalid()
		}
		if _, e := strconv.ParseInt(str(a), 10, 64); e != nil {
			return nil, invalid()
		}
	}
	return o, nil
}
func ParseAssignment(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "expectedVersion", "roleId", "enabled"}, []string{"id"}) || !uuidPattern.MatchString(str(input["operationId"])) || !uuidPattern.MatchString(str(input["roleId"])) || !whole(input["expectedVersion"], 0, 9007199254740991) {
		return nil, invalid()
	}
	if _, ok := input["enabled"].(bool); !ok {
		return nil, invalid()
	}
	if v, ok := input["id"]; ok && !uuidPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	return cloneObject(input), nil
}

// Intent deliberately excludes the temporary password from durable JSON/audit.
func Intent(input Object) Object { o := cloneObject(input); delete(o, "temporaryPassword"); return o }
