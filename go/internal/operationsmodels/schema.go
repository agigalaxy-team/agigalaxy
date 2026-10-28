package operationsmodels

import (
	whatwg "github.com/nlnwa/whatwg-url/url"
	"math/big"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var refPattern = regexp.MustCompile(`^model-key:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

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
func text(v any, min, max int) bool {
	s, ok := v.(string)
	n := utf8.RuneCountInString(s)
	return ok && n >= min && n <= max
}
func noControl(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) {
			return false
		}
	}
	return true
}
func noSpace(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) || unicode.IsSpace(r) || r == '\ufeff' {
			return false
		}
	}
	return true
}
func parseUUID(v any) (string, bool) {
	s := str(v)
	return strings.ToLower(s), uuidPattern.MatchString(s)
}
func parseBinding(v any) (Object, bool) {
	o := obj(v)
	if !closed(o, []string{"modelId", "dataPolicyApproved"}, nil) {
		return nil, false
	}
	id, ok := parseUUID(o["modelId"])
	if !ok {
		return nil, false
	}
	if _, ok := o["dataPolicyApproved"].(bool); !ok {
		return nil, false
	}
	return Object{"modelId": id, "dataPolicyApproved": o["dataPolicyApproved"]}, true
}
func parseReasoning(v any) (Object, bool) {
	o := obj(v)
	if !closed(o, []string{"mode", "effort", "supportedEfforts", "supportSource"}, nil) || !has([]string{"default", "effort"}, str(o["mode"])) || o["supportSource"] != "manual" || !isArray(o["supportedEfforts"]) || len(list(o["supportedEfforts"])) > 16 {
		return nil, false
	}
	seen := map[string]bool{}
	for _, v := range list(o["supportedEfforts"]) {
		if !has(Efforts, str(v)) || seen[str(v)] {
			return nil, false
		}
		seen[str(v)] = true
	}
	if o["mode"] == "default" && o["effort"] != nil || o["mode"] == "effort" && (o["effort"] == nil || !seen[str(o["effort"])]) {
		return nil, false
	}
	if o["effort"] != nil && !has(Efforts, str(o["effort"])) {
		return nil, false
	}
	return clone(o), true
}
func baseURL(v any) (any, bool) {
	if v == nil {
		return nil, true
	}
	if _, ok := v.(string); !ok {
		return nil, false
	}
	s := trim(str(v))
	if !text(s, 1, 2048) || !noSpace(s) || !regexp.MustCompile(`(?i)^https?://`).MatchString(s) {
		return nil, false
	}
	u, e := whatwg.Parse(s)
	if e != nil || u.Hostname() == "" || u.Username() != "" || u.Password() != "" || u.Search() != "" || u.Hash() != "" {
		return nil, false
	}
	if u.Scheme() == "https" {
		return s, true
	}
	a := regexp.MustCompile(`(?i)^http://([^/]+)`).FindStringSubmatch(s)
	return s, len(a) == 2 && regexp.MustCompile(`(?i)^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$`).MatchString(a[1])
}
func parseModel(v any) (Object, bool) {
	o := obj(v)
	required := []string{"id", "displayName", "modelId", "apiFormat", "baseUrl", "credentialRef", "contextWindow", "maxOutputTokens", "timeoutSeconds", "reasoning", "toolCalling", "structuredOutput", "enabled"}
	if !closed(o, required, []string{"imageUnderstanding", "parallelToolCalls", "verbosity", "fallbacks"}) {
		return nil, false
	}
	out := clone(o)
	id, ok := parseUUID(o["id"])
	if !ok {
		return nil, false
	}
	out["id"] = id
	if _, ok := o["displayName"].(string); !ok {
		return nil, false
	}
	out["displayName"] = trim(str(o["displayName"]))
	if !text(out["displayName"], 1, 100) || !has(Formats, str(o["apiFormat"])) {
		return nil, false
	}
	if o["modelId"] != nil && (!text(o["modelId"], 1, 200) || !noSpace(str(o["modelId"]))) {
		return nil, false
	}
	if out["baseUrl"], ok = baseURL(o["baseUrl"]); !ok {
		return nil, false
	}
	if o["credentialRef"] != nil && !refPattern.MatchString(str(o["credentialRef"])) {
		return nil, false
	}
	for _, k := range []string{"contextWindow", "maxOutputTokens", "timeoutSeconds"} {
		max := int64(100000000)
		if k == "timeoutSeconds" {
			max = 1800
		}
		if o[k] != nil && !integer(o[k], 1, max) {
			return nil, false
		}
	}
	reason, ok := parseReasoning(o["reasoning"])
	if !ok {
		return nil, false
	}
	out["reasoning"] = reason
	for _, k := range []string{"toolCalling", "structuredOutput", "enabled"} {
		if _, ok := o[k].(bool); !ok {
			return nil, false
		}
	}
	if v, exists := o["imageUnderstanding"]; exists {
		if _, ok := v.(bool); !ok {
			return nil, false
		}
	}
	if v, exists := o["parallelToolCalls"]; exists && v != nil {
		if _, ok := v.(bool); !ok || o["toolCalling"] != true {
			return nil, false
		}
	}
	if v, exists := o["verbosity"]; exists && v != nil {
		if !has([]string{"low", "medium", "high"}, str(v)) || !has([]string{"openai-chat", "openai-responses"}, str(o["apiFormat"])) {
			return nil, false
		}
	}
	if o["contextWindow"] != nil && o["maxOutputTokens"] != nil && num(o["maxOutputTokens"]) >= num(o["contextWindow"]) {
		return nil, false
	}
	if o["apiFormat"] == "openai-responses" && o["maxOutputTokens"] != nil && num(o["maxOutputTokens"]) < 16 {
		return nil, false
	}
	if o["apiFormat"] == "gemini" && reason["mode"] == "effort" && !has([]string{"none", "minimal", "low", "medium", "high"}, str(reason["effort"])) {
		return nil, false
	}
	if v, exists := o["fallbacks"]; exists {
		if !isArray(v) || len(list(v)) > 3 {
			return nil, false
		}
		rows := []any{}
		seen := map[string]bool{}
		for _, v := range list(v) {
			b, ok := parseBinding(v)
			if !ok || b["modelId"] == id || seen[str(b["modelId"])] {
				return nil, false
			}
			seen[str(b["modelId"])] = true
			rows = append(rows, b)
		}
		out["fallbacks"] = rows
	}
	return out, true
}
func EmptyConfiguration() Object {
	s := Object{}
	for _, d := range Domains {
		s[d] = nil
	}
	return Object{"models": []any{}, "scenarios": s}
}
func ParseConfiguration(input Object) (Object, error) {
	if !closed(input, []string{"models", "scenarios"}, nil) || !isArray(input["models"]) || len(list(input["models"])) > 50 {
		return nil, invalid()
	}
	scenarios := obj(input["scenarios"])
	if !closed(scenarios, Domains, nil) {
		return nil, invalid()
	}
	models := []any{}
	ids := map[string]bool{}
	for _, v := range list(input["models"]) {
		m, ok := parseModel(v)
		if !ok || ids[str(m["id"])] {
			return nil, invalid()
		}
		ids[str(m["id"])] = true
		models = append(models, m)
	}
	for _, v := range models {
		for _, v := range list(obj(v)["fallbacks"]) {
			if !ids[str(obj(v)["modelId"])] {
				return nil, invalid()
			}
		}
	}
	out := Object{}
	for _, d := range Domains {
		out[d] = nil
		if scenarios[d] != nil {
			b, ok := parseBinding(scenarios[d])
			if !ok || !ids[str(b["modelId"])] {
				return nil, invalid()
			}
			out[d] = b
		}
	}
	return Object{"models": models, "scenarios": out}, nil
}
func AssertApplicable(configuration Object) (Object, error) {
	c, e := ParseConfiguration(configuration)
	if e != nil {
		return nil, e
	}
	models := map[string]Object{}
	for _, v := range list(c["models"]) {
		models[str(obj(v)["id"])] = obj(v)
	}
	for _, v := range list(c["models"]) {
		m := obj(v)
		if m["enabled"] != true {
			continue
		}
		for _, k := range []string{"modelId", "baseUrl", "contextWindow", "maxOutputTokens", "timeoutSeconds", "credentialRef"} {
			if m[k] == nil {
				return nil, fail("model_settings_model_incomplete", 409)
			}
		}
		for _, v := range list(m["fallbacks"]) {
			b := obj(v)
			target := models[str(b["modelId"])]
			if target["enabled"] != true {
				return nil, fail("model_settings_fallback_unavailable", 409)
			}
			if b["dataPolicyApproved"] != true {
				return nil, fail("model_settings_fallback_data_policy_unapproved", 409)
			}
			for _, k := range []string{"toolCalling", "structuredOutput", "imageUnderstanding"} {
				if m[k] == true && target[k] != true {
					return nil, fail("model_settings_fallback_capability_incompatible", 409)
				}
			}
		}
	}
	for _, d := range Domains {
		b := obj(obj(c["scenarios"])[d])
		if b == nil {
			continue
		}
		if models[str(b["modelId"])]["enabled"] != true {
			return nil, fail("model_settings_binding_unavailable", 409)
		}
		if b["dataPolicyApproved"] != true {
			return nil, fail("model_settings_data_policy_unapproved", 409)
		}
	}
	return c, nil
}
func ParseCommand(kind string, input Object) (Object, error) {
	required := []string{"operationId"}
	switch kind {
	case "draft":
		required = append(required, "expectedRevision", "configuration", "reason")
	case "apply":
		required = append(required, "expectedRevision", "versionId", "reason")
	case "credential-provision":
		required = append(required, "modelRecordId", "apiKey")
	default:
		return nil, invalid()
	}
	if !closed(input, required, nil) {
		return nil, invalid()
	}
	x := clone(input)
	for _, k := range []string{"operationId", "versionId", "modelRecordId"} {
		if v, ok := x[k]; ok {
			id, valid := parseUUID(v)
			if !valid {
				return nil, invalid()
			}
			x[k] = id
		}
	}
	if kind != "credential-provision" {
		if !integer(x["expectedRevision"], 0, 2147483646) {
			return nil, invalid()
		}
		if _, ok := x["reason"].(string); !ok {
			return nil, invalid()
		}
		x["reason"] = trim(str(x["reason"]))
		if !text(x["reason"], 1, 500) {
			return nil, invalid()
		}
	}
	if kind == "draft" {
		c, e := ParseConfiguration(obj(x["configuration"]))
		if e != nil {
			return nil, e
		}
		x["configuration"] = c
	}
	if kind == "credential-provision" && (!text(x["apiKey"], 1, 16384) || trim(str(x["apiKey"])) != str(x["apiKey"]) || !noControl(str(x["apiKey"]))) {
		return nil, invalid()
	}
	return x, nil
}
func ParseQuery(kind string, input Object) (Object, error) {
	out := clone(input)
	switch kind {
	case "history":
		if !closed(input, nil, []string{"after", "limit"}) {
			return nil, invalid()
		}
		if _, ok := out["limit"]; !ok {
			out["limit"] = 20
		}
		if !integer(out["limit"], 1, 50) {
			return nil, invalid()
		}
		if v, ok := out["after"]; ok {
			s := str(v)
			n, valid := new(big.Int).SetString(s, 10)
			if !regexp.MustCompile(`^[1-9][0-9]{0,18}$`).MatchString(s) || !valid || n.Cmp(big.NewInt(9223372036854775807)) > 0 {
				return nil, invalid()
			}
		}
	case "usage":
		if !closed(input, nil, []string{"days"}) {
			return nil, invalid()
		}
		if _, ok := out["days"]; !ok {
			out["days"] = 7
		}
		if !integer(out["days"], 7, 30) || num(out["days"]) != 7 && num(out["days"]) != 30 {
			return nil, invalid()
		}
	default:
		return nil, invalid()
	}
	return out, nil
}
