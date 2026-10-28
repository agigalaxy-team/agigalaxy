package agentos

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

func executionStrict(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, key := range required {
		if _, ok := o[key]; !ok {
			return false
		}
	}
	for key := range o {
		if !slices.Contains(required, key) && !slices.Contains(optional, key) {
			return false
		}
	}
	return true
}
func executionIDs(v any) ([]string, bool) {
	a, ok := v.([]string)
	if !ok {
		raw, yes := v.([]any)
		if !yes {
			return nil, false
		}
		a = []string{}
		for _, v := range raw {
			x, yes := v.(string)
			if !yes {
				return nil, false
			}
			a = append(a, x)
		}
	}
	if len(a) > 100 {
		return nil, false
	}
	seen := map[string]bool{}
	for _, id := range a {
		if !validOperationID(id) || seen[id] {
			return nil, false
		}
		seen[id] = true
	}
	return append([]string{}, a...), true
}
func executionTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return r == '\ufeff' || unicode.IsSpace(r) && r != 0x85 })
}
func parseExecutionCreate(input Object) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_operations_agentos_request", 400) }
	if !executionStrict(input, []string{"operationId", "grantId", "expectedGrantVersion", "domain", "actions", "resourceIds"}, []string{"preparedCommand"}) || !validOperationID(text(input, "operationId")) || !validOperationID(text(input, "grantId")) || !slices.Contains(operationsai.Domains, text(input, "domain")) {
		return invalid()
	}
	version, ok := index(input["expectedGrantVersion"])
	if !ok || version < 1 {
		return invalid()
	}
	ids, ok := executionIDs(input["resourceIds"])
	if !ok {
		return invalid()
	}
	actions, ok := input["actions"].([]string)
	if !ok {
		a, yes := input["actions"].([]any)
		if !yes {
			return invalid()
		}
		actions = []string{}
		for _, v := range a {
			s, yes := v.(string)
			if !yes {
				return invalid()
			}
			actions = append(actions, s)
		}
	}
	if len(actions) > 100 {
		return invalid()
	}
	seen := map[string]bool{}
	for _, code := range actions {
		if seen[code] || !slices.Contains(operationspermissions.PermissionCodes(), code) {
			return invalid()
		}
		seen[code] = true
	}
	out := Object{"operationId": input["operationId"], "grantId": input["grantId"], "expectedGrantVersion": version, "domain": input["domain"], "actions": append([]string{}, actions...), "resourceIds": ids, "preparedCommand": nil}
	if input["preparedCommand"] != nil {
		p := object(input["preparedCommand"])
		if !executionStrict(p, []string{"tool", "targetKind", "targetId", "input"}, nil) || p["tool"] != "content-visibility" || !slices.Contains([]string{"post", "reply"}, text(p, "targetKind")) || !validOperationID(text(p, "targetId")) {
			return invalid()
		}
		x := object(p["input"])
		if !executionStrict(x, []string{"expectedVersion", "expectedRevision", "kind", "reason"}, []string{"until"}) || !slices.Contains([]string{"hide", "restore"}, text(x, "kind")) {
			return invalid()
		}
		ev, yes := index(x["expectedVersion"])
		if !yes {
			return invalid()
		}
		er, yes := index(x["expectedRevision"])
		if !yes {
			return invalid()
		}
		raw, yes := x["reason"].(string)
		if !yes {
			return invalid()
		}
		reason := executionTrim(raw)
		if n := utf8.RuneCountInString(reason); n < 3 || n > 1600 {
			return invalid()
		}
		inner := Object{"expectedVersion": ev, "expectedRevision": er, "kind": x["kind"], "reason": reason}
		until, has := x["until"]
		if x["kind"] == "hide" {
			n, yes := index(until)
			if !has || !yes || n < 1 {
				return invalid()
			}
			inner["until"] = n
		} else if has {
			return invalid()
		}
		out["preparedCommand"] = Object{"tool": p["tool"], "targetKind": p["targetKind"], "targetId": p["targetId"], "input": inner}
	}
	return out, nil
}
func parseExecutionState(input Object) (Object, error) {
	if !executionStrict(input, []string{"operationId", "expectedRevision", "kind"}, nil) || !validOperationID(text(input, "operationId")) || !slices.Contains([]string{"pause", "resume", "stop"}, text(input, "kind")) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	revision, ok := index(input["expectedRevision"])
	if !ok || revision < 1 {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	return Object{"operationId": input["operationId"], "expectedRevision": revision, "kind": input["kind"]}, nil
}
