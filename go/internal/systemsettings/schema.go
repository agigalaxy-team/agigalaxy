package systemsettings

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"math"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var sections = []string{"mail", "service-connections"}
var purposes = []string{"operations", "account-authentication", "runtime-alerts"}
var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var keyRefPattern = regexp.MustCompile(`^system-key:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
var operatorPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func includes(a []string, s string) bool {
	for _, v := range a {
		if v == s {
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
func text(o Object, key string, max int) bool {
	if !parseText(o, key, 1, max, true) {
		return false
	}
	return !strings.ContainsFunc(str(o[key]), unicode.IsControl)
}
func parseUUID(v any, lower bool) (string, bool) {
	s, ok := v.(string)
	if !ok || !uuidPattern.MatchString(s) {
		return "", false
	}
	if lower {
		s = strings.ToLower(s)
	}
	return s, true
}
func setUUID(o Object, key string, lower bool) bool {
	s, ok := parseUUID(o[key], lower)
	if ok {
		o[key] = s
	}
	return ok
}
func secret(v any, min, max int) bool {
	s, ok := bounded(v, min, max, false)
	return ok && !strings.ContainsFunc(s, unicode.IsControl)
}
func normalizeHost(v any) (any, bool) {
	empty := Object{"enabled": false, "host": v, "port": nil, "tls": nil, "credentialRef": nil, "connectionTimeoutMs": nil, "greetingTimeoutMs": nil, "socketTimeoutMs": nil, "maxConnections": nil, "rateLimit": nil, "rateWindowSeconds": nil, "dkimSelector": nil}
	o, e := messaging.ParseSMTPConfiguration(empty)
	return o["host"], e == nil
}

var transportFields = []string{"host", "port", "tls", "connectionTimeoutMs", "greetingTimeoutMs", "socketTimeoutMs", "maxConnections", "rateLimit", "rateWindowSeconds", "dkimSelector"}

func parseMailConnection(input Object) (Object, error) {
	required := append([]string{"id", "name", "credentialRef"}, transportFields...)
	if !closed(input, required, nil) {
		return nil, invalid()
	}
	x := clone(input)
	if !setUUID(x, "id", true) || !text(x, "name", 100) || x["credentialRef"] != nil && !keyRefPattern.MatchString(str(x["credentialRef"])) {
		return nil, invalid()
	}
	smtp := Object{"enabled": false, "credentialRef": nil}
	for _, k := range transportFields {
		smtp[k] = x[k]
	}
	parsed, e := messaging.ParseSMTPConfiguration(smtp)
	if e != nil {
		return nil, invalid()
	}
	for _, k := range transportFields {
		x[k] = parsed[k]
	}
	return x, nil
}
func parseOrigin(v any) (string, bool) {
	s, ok := bounded(v, 1, 2048, false)
	if !ok {
		return "", false
	}
	u, e := whatwg.Parse(s)
	if e != nil || u.Username() != "" || u.Password() != "" || u.Search() != "" || u.Hash() != "" || u.Pathname() != "" && u.Pathname() != "/" || u.Scheme() != "https" && (u.Scheme() != "http" || !includes([]string{"127.0.0.1", "localhost", "[::1]"}, u.Hostname())) {
		return "", false
	}
	return u.Scheme() + "://" + u.Host(), true
}

var serviceKinds = []string{"analysis", "recommendation", "search", "ai-execution", "file-scanning"}

func ParseServiceBinding(input Object, withRef bool) (Object, error) {
	kind := str(input["kind"])
	required := []string{"id", "kind"}
	switch kind {
	case "analysis":
		required = append(required, "url", "projectId", "clientId", "readClientId")
	case "recommendation", "ai-execution":
		required = append(required, "url")
	case "search":
		required = append(required, "url", "index")
	case "file-scanning":
		required = append(required, "host", "port", "timeoutMs")
	default:
		return nil, invalid()
	}
	if withRef && kind != "file-scanning" {
		required = append(required, "credentialRef")
	}
	if !closed(input, required, nil) {
		return nil, invalid()
	}
	x := clone(input)
	if !setUUID(x, "id", false) {
		return nil, invalid()
	}
	if kind == "file-scanning" {
		if !includes([]string{"127.0.0.1", "::1", "localhost"}, str(x["host"])) || !whole(x["port"], 1, 65535) || !whole(x["timeoutMs"], 1000, 60000) {
			return nil, invalid()
		}
		return x, nil
	}
	origin, ok := parseOrigin(x["url"])
	if !ok {
		return nil, invalid()
	}
	x["url"] = origin
	if kind == "analysis" {
		for _, k := range []string{"projectId", "clientId", "readClientId"} {
			if !setUUID(x, k, false) {
				return nil, invalid()
			}
		}
	}
	if kind == "search" && !regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`).MatchString(str(x["index"])) {
		return nil, invalid()
	}
	if withRef && x["credentialRef"] != nil && !keyRefPattern.MatchString(str(x["credentialRef"])) {
		return nil, invalid()
	}
	return x, nil
}
func ParseConfiguration(section string, input Object) (Object, error) {
	if section == "mail" {
		if !closed(input, []string{"connections", "bindings"}, nil) {
			return nil, invalid()
		}
		rows, ok := input["connections"].([]any)
		if !ok || len(rows) > 16 || !closed(obj(input["bindings"]), purposes, nil) {
			return nil, invalid()
		}
		connections := []any{}
		ids := map[string]bool{}
		for _, r := range rows {
			row, e := parseMailConnection(obj(r))
			if e != nil || ids[str(row["id"])] {
				return nil, invalid()
			}
			ids[str(row["id"])] = true
			connections = append(connections, row)
		}
		bindings := clone(obj(input["bindings"]))
		for _, k := range purposes {
			if bindings[k] != nil {
				if !setUUID(bindings, k, true) || !ids[str(bindings[k])] {
					return nil, invalid()
				}
			}
		}
		return Object{"connections": connections, "bindings": bindings}, nil
	}
	if section != "service-connections" || !closed(input, []string{"connections"}, nil) {
		return nil, invalid()
	}
	rows, ok := input["connections"].([]any)
	if !ok || len(rows) > 5 {
		return nil, invalid()
	}
	connections := []any{}
	ids, kinds := map[string]bool{}, map[string]bool{}
	for _, r := range rows {
		row, e := ParseServiceBinding(obj(r), true)
		if e != nil || ids[str(row["id"])] || kinds[str(row["kind"])] {
			return nil, invalid()
		}
		ids[str(row["id"])], kinds[str(row["kind"])] = true, true
		connections = append(connections, row)
	}
	return Object{"connections": connections}, nil
}
func AssertEffectConfiguration(section string, input Object, kind, connectionID string) error {
	value, e := ParseConfiguration(section, input)
	if e != nil {
		return e
	}
	selected := []Object{}
	for _, v := range list(value["connections"]) {
		r := obj(v)
		take := kind == "test" && (connectionID == "" || r["id"] == connectionID) || kind != "test" && section != "mail"
		if kind != "test" && section == "mail" {
			for _, id := range obj(value["bindings"]) {
				take = take || id == r["id"]
			}
		}
		if take {
			selected = append(selected, r)
		}
	}
	bad := func() error { return fail("system_settings_configuration_incomplete", 409) }
	if len(selected) == 0 {
		return bad()
	}
	for _, r := range selected {
		if section == "mail" {
			for _, k := range []string{"host", "port", "tls", "credentialRef"} {
				if r[k] == nil || r[k] == "" {
					return bad()
				}
			}
			if kind == "apply" && obj(value["bindings"])["operations"] == r["id"] {
				for _, k := range []string{"connectionTimeoutMs", "greetingTimeoutMs", "socketTimeoutMs", "maxConnections", "rateLimit", "rateWindowSeconds"} {
					if r[k] == nil {
						return bad()
					}
				}
			}
		} else if r["kind"] != "file-scanning" && r["credentialRef"] == nil {
			return bad()
		}
	}
	return nil
}
func ParseCommand(kind string, input Object) (Object, error) {
	required := []string{"operationId", "expectedRevision"}
	optional := []string{}
	switch kind {
	case "save":
		required = append(required, "configuration")
	case "test":
		required = append(required, "versionId")
		optional = append(optional, "connectionId")
	case "apply":
		required = append(required, "versionId")
	case "credential":
		required = append(required, "connectionId", "section", "binding", "credential")
	default:
		return nil, invalid()
	}
	if !closed(input, required, optional) {
		return nil, invalid()
	}
	x := clone(input)
	if !setUUID(x, "operationId", true) || !whole(x["expectedRevision"], 0, 2147483646) {
		return nil, invalid()
	}
	if kind == "test" || kind == "apply" {
		if !setUUID(x, "versionId", true) {
			return nil, invalid()
		}
		if _, ok := x["connectionId"]; ok && !setUUID(x, "connectionId", true) {
			return nil, invalid()
		}
	}
	if kind == "credential" {
		if !setUUID(x, "connectionId", true) || !includes(sections, str(x["section"])) {
			return nil, invalid()
		}
		binding := obj(x["binding"])
		credential := obj(x["credential"])
		if x["section"] == "mail" {
			if !closed(binding, []string{"id", "host", "port", "tls"}, nil) || !closed(credential, []string{"user", "password"}, nil) {
				return nil, invalid()
			}
			binding = clone(binding)
			host, ok := normalizeHost(binding["host"])
			if !ok || host == nil || !setUUID(binding, "id", true) || !whole(binding["port"], 1, 65535) || !includes([]string{"implicit", "starttls"}, str(binding["tls"])) || !secret(credential["user"], 1, 320) || !secret(credential["password"], 1, 4096) {
				return nil, invalid()
			}
			binding["host"] = host
		} else {
			_, e := ParseServiceBinding(binding, false)
			if e != nil {
				return nil, e
			}
			if !ServiceCredentialsConfigured(str(binding["kind"]), credential) {
				return nil, invalid()
			}
		}
		if binding["id"] != x["connectionId"] {
			return nil, invalid()
		}
		x["binding"] = binding
	}
	return x, nil
}
func CredentialMetadata(input Object) Object { x := clone(input); delete(x, "credential"); return x }
