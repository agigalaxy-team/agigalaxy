package actions

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"strings"
	"unicode/utf8"
)

func parseDiscoveryRequest(input Object) (Object, error) {
	x := clone(input)
	kind := str(x["kind"])
	fields := []string{"kind", "reason"}
	optional := []string{}
	if kind == "search-draft-save" {
		fields = append(fields, "settings")
		optional = append(optional, "expectedDraftId")
	} else if kind == "search-restore" {
		fields = append(fields, "versionId")
	} else if kind == "recommendation-direction" {
		fields = append(fields, "themeKey", "direction")
	} else if kind != "search-apply" {
		return nil, invalid()
	}
	if !exact(x, fields, optional) {
		return nil, invalid()
	}
	reason, ok := x["reason"].(string)
	reason = trim(reason)
	if !ok || utf8.RuneCountInString(reason) < 1 || utf8.RuneCountInString(reason) > 500 {
		return nil, invalid()
	}
	x["reason"] = reason
	if kind == "search-draft-save" {
		command := Object{"operationId": "00000000-0000-0000-0000-000000000000", "expectedRevision": 0, "reason": reason, "settings": x["settings"], "expectedDraftId": x["expectedDraftId"]}
		parsed, e := discovery.ParseSearchCommand("prepared-draft", command)
		if e != nil {
			return nil, e
		}
		x["settings"] = parsed["settings"]
		if parsed["expectedDraftId"] != nil {
			x["expectedDraftId"] = parsed["expectedDraftId"]
		} else {
			delete(x, "expectedDraftId")
		}
	}
	if kind == "search-restore" && !validID(x["versionId"]) {
		return nil, invalid()
	}
	if kind == "recommendation-direction" {
		value, e := discovery.ParseRecommendationPolicy(Object{"operationId": "00000000-0000-0000-0000-000000000000", "expectedVersion": 0, "enabled": false, "themeKey": x["themeKey"], "direction": x["direction"], "controls": Object{"avoidRepetition": false, "avoidConcentration": false}, "reason": reason})
		if e != nil {
			return nil, invalid()
		}
		x["themeKey"], x["direction"] = value["themeKey"], value["direction"]
	}
	return x, nil
}
func recommendationPolicyBody(input Object) Object {
	return pick(input, "operationId", "expectedVersion", "enabled", "themeKey", "direction", "controls", "reason")
}
func normalizeDiscoveryCommand(x, command, proposal Object) (Object, error) {
	kind := str(x["kind"])
	if kind == "search-draft-save" {
		out, e := discovery.ParseSearchCommand("prepared-draft", command)
		if e != nil || !same(out["settings"], x["settings"]) || out["reason"] != x["reason"] || !same(out["expectedDraftId"], x["expectedDraftId"]) {
			return nil, invalid()
		}
		return out, nil
	}
	if kind != "recommendation-direction" {
		if !exact(command, []string{"operationId", "expectedRevision", "versionId", "reason"}, nil) {
			return nil, invalid()
		}
		if kind == "search-restore" && command["versionId"] != x["versionId"] {
			return nil, invalid()
		}
		if !validID(command["operationId"]) || !validID(command["versionId"]) {
			return nil, invalid()
		}
		if _, ok := integer(command["expectedRevision"]); !ok {
			return nil, invalid()
		}
		reason, ok := command["reason"].(string)
		reason = trim(reason)
		if !ok || utf8.RuneCountInString(reason) < 1 || utf8.RuneCountInString(reason) > 500 || reason != x["reason"] {
			return nil, invalid()
		}
		// The original card schema allows a nonnegative safe integer. The
		// owning command separately enforces its actual bounded DB revision.
		normalized := clone(command)
		normalized["reason"] = reason
		return normalized, nil
	}
	if !exact(command, []string{"operationId", "expectedVersion", "enabled", "themeKey", "direction", "controls", "reason", "beforeDirections", "themeVersion", "themeEnabled"}, nil) {
		return nil, invalid()
	}
	out, e := discovery.ParseRecommendationPolicy(recommendationPolicyBody(command))
	if e != nil {
		return nil, invalid()
	}
	if out["themeKey"] != x["themeKey"] || out["direction"] != x["direction"] || out["reason"] != x["reason"] {
		return nil, invalid()
	}
	version, ok := integer(command["themeVersion"])
	enabled, good := command["themeEnabled"].(bool)
	if !ok || version > 2147483646 || !good {
		return nil, invalid()
	}
	before := items(command["beforeDirections"])
	if before == nil {
		return nil, invalid()
	}
	normalized := []any{}
	seen := map[string]bool{}
	for _, v := range before {
		row := obj(v)
		if !exact(row, []string{"key", "direction"}, nil) {
			return nil, invalid()
		}
		trial := recommendationPolicyBody(command)
		trial["themeKey"], trial["direction"] = row["key"], row["direction"]
		parsed, e := discovery.ParseRecommendationPolicy(trial)
		if e != nil {
			return nil, invalid()
		}
		key := strings.ToLower(str(parsed["themeKey"]))
		if seen[key] {
			return nil, invalid()
		}
		seen[key] = true
		normalized = append(normalized, Object{"key": key, "direction": parsed["direction"]})
	}
	out["beforeDirections"], out["themeVersion"], out["themeEnabled"] = normalized, version, enabled
	return out, nil
}
