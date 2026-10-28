package operationsmodels

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"net/http"
	"regexp"
	"time"
)

var nativeCodePattern = regexp.MustCompile(`^(?:models|model_settings|model_configuration)_[a-z0-9_]{1,80}$`)
var versionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

func responseInvalid() error { return fail("model_settings_native_response_invalid", 503) }
func timestamp(v any) any {
	s := str(v)
	if !regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$`).MatchString(s) {
		return nil
	}
	if _, e := time.Parse(time.RFC3339Nano, s); e != nil {
		return nil
	}
	return s
}
func nullableVersion(v any) any {
	if versionPattern.MatchString(str(v)) {
		return v
	}
	return nil
}
func count(v any) any {
	if integer(v, 0, 9007199254740991) {
		return v
	}
	return nil
}
func availability(v any) Object {
	state := "unavailable"
	if obj(v)["state"] == "available" {
		state = "available"
	}
	return Object{"state": state}
}
func counts(v any, keys []string) Object {
	o := Object{}
	for _, k := range keys {
		o[k] = count(obj(v)[k])
	}
	return o
}
func ProjectCredential(v Object) (Object, error) {
	id, ok := parseUUID(v["modelRecordId"])
	if !ok || !refPattern.MatchString(str(v["reference"])) {
		return nil, responseInvalid()
	}
	if _, ok := v["configured"].(bool); !ok {
		return nil, responseInvalid()
	}
	return Object{"reference": v["reference"], "modelRecordId": id, "configured": v["configured"]}, nil
}
func ProjectOperation(v Object) (Object, error) {
	id, ok := parseUUID(v["id"])
	if !ok || !has([]string{"models-apply", "models-credential-provision"}, str(v["kind"])) || !has([]string{"accepted", "running", "completed", "failed", "unknown"}, str(v["state"])) {
		return nil, responseInvalid()
	}
	o := Object{"id": id, "kind": v["kind"], "state": v["state"], "code": nil, "startedAt": timestamp(v["startedAt"]), "finishedAt": timestamp(v["finishedAt"])}
	if nativeCodePattern.MatchString(str(v["code"])) {
		o["code"] = v["code"]
	}
	if r, ok := v["credentialRef"]; ok {
		if !refPattern.MatchString(str(r)) {
			return nil, responseInvalid()
		}
		o["credentialRef"] = r
	}
	return o, nil
}
func ProjectStatus(v Object) (Object, error) {
	engines := obj(v["engines"])
	gateway, agent := obj(engines["gateway"]), obj(engines["agentos"])
	if engines == nil || gateway == nil || agent == nil || !isArray(agent["configuredScenarios"]) || len(list(agent["configuredScenarios"])) > 5 || !isArray(v["credentials"]) || len(list(v["credentials"])) > 1000 {
		return nil, responseInvalid()
	}
	seen := map[string]bool{}
	scenarios := []any{}
	for _, d := range list(agent["configuredScenarios"]) {
		if !has(Domains, str(d)) || seen[str(d)] {
			return nil, responseInvalid()
		}
		seen[str(d)] = true
		scenarios = append(scenarios, d)
	}
	credentials := []any{}
	for _, r := range list(v["credentials"]) {
		c, e := ProjectCredential(obj(r))
		if e != nil {
			return nil, e
		}
		credentials = append(credentials, c)
	}
	state := func(v any) string {
		if has([]string{"available", "ready", "running", "configured", "not-configured", "unavailable", "unknown"}, str(v)) {
			return str(v)
		}
		return "unknown"
	}
	var applied any
	if id, ok := parseUUID(v["appliedVersionId"]); ok {
		applied = id
	}
	out := Object{"availability": availability(v["availability"]), "configurationVersion": nullableVersion(v["configurationVersion"]), "appliedVersionId": applied, "engines": Object{"gateway": Object{"state": state(gateway["state"]), "configurationVersion": nullableVersion(gateway["configurationVersion"]), "modelCount": count(gateway["modelCount"])}, "agentos": Object{"state": state(agent["state"]), "configurationVersion": nullableVersion(agent["configurationVersion"]), "configuredScenarios": scenarios}}, "credentials": credentials}
	if r, ok := v["operation"]; ok {
		o, e := ProjectOperation(obj(r))
		if e != nil {
			return nil, e
		}
		out["operation"] = o
	}
	return out, nil
}

var callKeys = []string{"total", "completed", "failed", "unknown"}
var tokenKeys = []string{"input", "output", "total", "cachedInput", "reasoning"}

func ProjectUsage(v Object) (Object, error) {
	if !integer(v["days"], 7, 30) || num(v["days"]) != 7 && num(v["days"]) != 30 || !isArray(v["byScenario"]) || len(list(v["byScenario"])) > 5 || !isArray(v["byModel"]) || len(list(v["byModel"])) > 1000 {
		return nil, responseInvalid()
	}
	out := Object{"availability": availability(v["availability"]), "days": v["days"], "from": timestamp(v["from"]), "to": timestamp(v["to"]), "coverageFrom": timestamp(v["coverageFrom"]), "coversWholeWindow": nil, "calls": counts(v["calls"], callKeys), "tokens": counts(v["tokens"], tokenKeys), "unknownUsageCalls": count(v["unknownUsageCalls"])}
	if b, ok := v["coversWholeWindow"].(bool); ok {
		out["coversWholeWindow"] = b
	}
	for _, key := range []string{"byScenario", "byModel"} {
		rows := []any{}
		for _, v := range list(v[key]) {
			r := obj(v)
			o := Object{"calls": counts(r["calls"], callKeys), "tokens": counts(r["tokens"], tokenKeys), "unknownUsageCalls": count(r["unknownUsageCalls"])}
			if key == "byScenario" {
				if !has(Domains, str(r["domain"])) {
					return nil, responseInvalid()
				}
				o["domain"] = r["domain"]
			} else {
				id, ok := parseUUID(r["modelRecordId"])
				if !ok {
					return nil, responseInvalid()
				}
				o["modelRecordId"] = id
			}
			rows = append(rows, o)
		}
		out[key] = rows
	}
	return out, nil
}
func ParseNativeCommand(input Object, authorization bool) (Object, error) {
	kind := str(input["kind"])
	if authorization && !has([]string{"models-apply", "models-credential-provision"}, kind) {
		return nil, invalid()
	}
	required := []string{"kind"}
	switch kind {
	case "models-overview":
	case "models-usage":
		required = append(required, "days")
	case "models-operation":
		required = append(required, "operationId")
	case "models-apply":
		required = append(required, "operationId", "operatorId", "versionId", "revision", "configuration")
	case "models-credential-provision":
		required = append(required, "operationId", "operatorId", "modelRecordId")
		if !authorization {
			required = append(required, "apiKey")
		}
	default:
		return nil, invalid()
	}
	if !closed(input, required, nil) {
		return nil, invalid()
	}
	x := clone(input)
	for _, k := range []string{"operationId", "modelRecordId", "versionId"} {
		if v, ok := x[k]; ok {
			id, valid := parseUUID(v)
			if !valid {
				return nil, invalid()
			}
			x[k] = id
		}
	}
	if v, ok := x["operatorId"]; ok && !text(v, 1, 500) {
		return nil, invalid()
	}
	if kind == "models-apply" {
		if !integer(x["revision"], 0, 2147483646) {
			return nil, invalid()
		}
		c, e := ParseConfiguration(obj(x["configuration"]))
		if e != nil {
			return nil, e
		}
		x["configuration"] = c
	}
	if kind == "models-credential-provision" && !authorization {
		if !text(x["apiKey"], 1, 16384) || !noControl(str(x["apiKey"])) || trim(str(x["apiKey"])) != x["apiKey"] {
			return nil, invalid()
		}
	}
	if kind == "models-usage" {
		if _, e := ParseQuery("usage", Object{"days": x["days"]}); e != nil {
			return nil, e
		}
	}
	return x, nil
}

type NativeClient struct {
	Client    *maintenance.Client
	Transport func(context.Context, Object) (Object, error)
}
type nativeError struct {
	error
	NativeStatus int
}

func (e *nativeError) Unwrap() error { return e.error }
func (n *NativeClient) Call(ctx context.Context, input Object) (Object, error) {
	x, e := ParseNativeCommand(input, false)
	if e != nil {
		return nil, e
	}
	if n.Transport != nil {
		return n.Transport(ctx, x)
	}
	if n.Client == nil {
		return nil, fail("model_settings_native_not_configured", 503)
	}
	raw, e := protocol.EncodeJS(x)
	if e != nil || len(raw) > 65536 {
		return nil, invalid()
	}
	b, status, e := n.Client.ModelSettings(ctx, raw)
	if e != nil {
		return nil, fail("model_settings_native_unavailable", 503)
	}
	var out Object
	if json.Unmarshal(b, &out) != nil || out == nil {
		return nil, fail("model_settings_native_unavailable", 503)
	}
	if status != 200 {
		code := str(out["error"])
		if !has([]string{"model_settings_native_busy", "model_settings_version_changed", "model_settings_configuration_invalid", "model_settings_credential_unavailable", "model_settings_permission_denied", "model_settings_authorization_unavailable"}, code) {
			code = "model_settings_native_unavailable"
		}
		mapped := 503
		if status == 400 || status == 403 || status == 409 {
			mapped = status
		}
		return nil, &nativeError{fail(code, mapped), status}
	}
	return out, nil
}
func (n *NativeClient) VerifyService(r *http.Request) (*maintenance.VerifiedService, error) {
	if n == nil || n.Client == nil {
		return nil, fail("model_settings_native_not_configured", 503)
	}
	return n.Client.VerifyService(r)
}
func (n *NativeClient) VerifyBody(p *maintenance.VerifiedService, raw []byte) error {
	return n.Client.VerifyBody(p, raw)
}
