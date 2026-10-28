package discovery

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"strings"
)

func recommendationInvalid() error { return qualityFailure("invalid_recommendation_request", 400) }
func themeKey(value string) bool {
	if protocol.TextLength(value) > 80 {
		return false
	}
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return false
	}
	if parts[0] == "category" {
		return topics[parts[1]]
	}
	return (parts[0] == "tag" || parts[0] == "theme") && validID(parts[1])
}
func parseRecommendationCommand(kind string, input Object) (Object, error) {
	fields := []string{"operationId", "expectedVersion", "enabled", "reason", "themeKey", "direction", "controls"}
	if kind == "theme" {
		fields = []string{"operationId", "themeId", "expectedVersion", "label", "enabled", "mapping", "reason"}
	} else if kind != "policy" {
		return nil, recommendationInvalid()
	}
	if !onlyKeys(input, fields...) || !validID(str(input, "operationId")) {
		return nil, recommendationInvalid()
	}
	version, ok := integer(input["expectedVersion"])
	enabled, enabledOK := input["enabled"].(bool)
	reason, reasonOK := input["reason"].(string)
	reason = strings.TrimFunc(reason, jsSpace)
	if !ok || version < 0 || version > 2147483646 || !enabledOK || !reasonOK || codePointLength(reason) < 1 || codePointLength(reason) > 500 {
		return nil, recommendationInvalid()
	}
	out := Object{"operationId": strings.ToLower(str(input, "operationId")), "expectedVersion": version, "enabled": enabled, "reason": reason}
	if kind == "policy" {
		key := str(input, "themeKey")
		direction := str(input, "direction")
		controls := object(input["controls"])
		_, repeat := controls["avoidRepetition"].(bool)
		_, concentration := controls["avoidConcentration"].(bool)
		if !themeKey(key) || (direction != "increase" && direction != "keep" && direction != "decrease") || controls == nil || !onlyKeys(controls, "avoidRepetition", "avoidConcentration") || !repeat || !concentration {
			return nil, recommendationInvalid()
		}
		out["themeKey"] = strings.ToLower(key)
		out["direction"] = direction
		out["controls"] = merge(Object{}, controls)
		return out, nil
	}
	if value, present := input["themeId"]; present {
		id, ok := value.(string)
		if !ok || !validID(id) {
			return nil, recommendationInvalid()
		}
		out["themeId"] = strings.ToLower(id)
	}
	label, labelOK := input["label"].(string)
	label = strings.TrimFunc(label, jsSpace)
	if !labelOK || codePointLength(label) < 1 || codePointLength(label) > 80 {
		return nil, recommendationInvalid()
	}
	mapping := object(input["mapping"])
	if mapping == nil || !onlyKeys(mapping, "categories", "tagIds", "queryTerms") {
		return nil, recommendationInvalid()
	}
	clean := Object{}
	total := 0
	for _, entry := range []struct {
		key   string
		limit int
	}{{"categories", 6}, {"tagIds", 32}, {"queryTerms", 24}} {
		values, ok := stringArray(mapping[entry.key])
		if !ok || len(values) > entry.limit {
			return nil, recommendationInvalid()
		}
		seen := map[string]bool{}
		for i, v := range values {
			switch entry.key {
			case "categories":
				if !topics[v] {
					return nil, recommendationInvalid()
				}
			case "tagIds":
				if !validID(v) {
					return nil, recommendationInvalid()
				}
				values[i] = strings.ToLower(v)
			case "queryTerms":
				values[i] = strings.TrimFunc(v, jsSpace)
				if codePointLength(values[i]) < 1 || codePointLength(values[i]) > 80 {
					return nil, recommendationInvalid()
				}
			}
			if seen[values[i]] {
				return nil, recommendationInvalid()
			}
			seen[values[i]] = true
		}
		clean[entry.key] = values
		total += len(values)
	}
	if total == 0 {
		return nil, recommendationInvalid()
	}
	out["mapping"] = clean
	out["label"] = label
	return out, nil
}

type ThemeExpectation struct {
	Key             string
	ExpectedVersion int64
	Enabled         bool
}
