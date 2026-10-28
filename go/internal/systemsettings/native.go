package systemsettings

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"net/http"
)

type NativeClient struct {
	Client    *maintenance.Client
	Transport func(context.Context, Object) (Object, error)
}

func errorCode(e error) string { return fault.Code(e) }
func ParseNativeCommand(input Object, authorization bool) (Object, error) {
	kind := str(input["kind"])
	if !authorization && kind == "settings-overview" {
		if !closed(input, []string{"kind", "section"}, nil) || !includes(sections, str(input["section"])) {
			return nil, invalid()
		}
		return clone(input), nil
	}
	if !authorization && kind == "settings-operation" {
		x := clone(input)
		if !closed(x, []string{"kind", "operationId", "operatorId", "section"}, nil) || !setUUID(x, "operationId", true) || !operatorPattern.MatchString(str(x["operatorId"])) || !includes(sections, str(x["section"])) {
			return nil, invalid()
		}
		return x, nil
	}
	if kind == "settings-credential-provision" {
		x := clone(input)
		delete(x, "kind")
		delete(x, "operatorId")
		if !operatorPattern.MatchString(str(input["operatorId"])) {
			return nil, invalid()
		}
		if !authorization {
			v, e := ParseCommand("credential", x)
			if e != nil {
				return nil, e
			}
			v["kind"], v["operatorId"], v["binding"], v["credential"] = kind, input["operatorId"], input["binding"], input["credential"]
			return v, nil
		}
		if !closed(x, []string{"operationId", "expectedRevision", "connectionId", "section", "binding"}, nil) || !setUUID(x, "operationId", true) || !setUUID(x, "connectionId", true) || !whole(x["expectedRevision"], 0, 2147483646) || !includes(sections, str(x["section"])) {
			return nil, invalid()
		}
		b := obj(x["binding"])
		if x["section"] == "mail" {
			if !closed(b, []string{"id", "host", "port", "tls"}, nil) {
				return nil, invalid()
			}
			b = clone(b)
			host, ok := normalizeHost(b["host"])
			if !ok || host == nil || !setUUID(b, "id", true) || !whole(b["port"], 1, 65535) || !includes([]string{"implicit", "starttls"}, str(b["tls"])) {
				return nil, invalid()
			}
			b["host"] = host
		} else {
			var e error
			b, e = ParseServiceBinding(b, false)
			if e != nil {
				return nil, e
			}
		}
		if obj(input["binding"])["id"] != x["connectionId"] {
			return nil, invalid()
		}
		x["binding"], x["kind"], x["operatorId"] = input["binding"], kind, input["operatorId"]
		return x, nil
	}
	if kind != "settings-test" && kind != "settings-apply" {
		return nil, invalid()
	}
	required := []string{"kind", "operationId", "operatorId", "section", "revision", "versionId", "configuration"}
	optional := []string{}
	if kind == "settings-test" {
		optional = append(optional, "connectionId")
	}
	x := clone(input)
	if !closed(x, required, optional) || !setUUID(x, "operationId", true) || !setUUID(x, "versionId", true) || !operatorPattern.MatchString(str(x["operatorId"])) || !includes(sections, str(x["section"])) || !whole(x["revision"], 0, 2147483646) {
		return nil, invalid()
	}
	if _, ok := x["connectionId"]; ok && !setUUID(x, "connectionId", true) {
		return nil, invalid()
	}
	if _, e := ParseConfiguration(str(x["section"]), obj(x["configuration"])); e != nil {
		return nil, e
	}
	return x, nil
}
func (n *NativeClient) Call(ctx context.Context, input Object) (Object, error) {
	x, e := ParseNativeCommand(input, false)
	if e != nil {
		return nil, e
	}
	body, e := protocol.EncodeJS(x)
	if e != nil || len(body) > 65536 {
		return nil, invalid()
	}
	if n.Transport != nil {
		return n.Transport(ctx, x)
	}
	if n.Client == nil {
		return nil, fail("system_settings_native_not_configured", 503)
	}
	raw, status, e := n.Client.SystemSettings(ctx, body)
	if e != nil {
		if fault.Code(e) == "maintenance_native_not_configured" {
			return nil, fail("system_settings_native_not_configured", 503)
		}
		return nil, fail("system_settings_native_unavailable", 503)
	}
	var value Object
	if json.Unmarshal(raw, &value) != nil {
		return nil, fail("system_settings_native_unavailable", 503)
	}
	if status != 200 {
		code := str(value["error"])
		if !includes(ErrorCodes, code) {
			code = "system_settings_native_unavailable"
		}
		if !includes([]string{"400", "401", "403", "404", "409", "413", "415"}, numberStatus(status)) {
			status = 503
		}
		return nil, fail(code, status)
	}
	return value, nil
}
func numberStatus(status int) string {
	switch status {
	case 400:
		return "400"
	case 401:
		return "401"
	case 403:
		return "403"
	case 404:
		return "404"
	case 409:
		return "409"
	case 413:
		return "413"
	case 415:
		return "415"
	}
	return ""
}
func (n *NativeClient) VerifyService(r *http.Request) (*maintenance.VerifiedService, error) {
	if n == nil || n.Client == nil {
		return nil, fail("maintenance_native_not_configured", 503)
	}
	return n.Client.VerifyService(r)
}
func (n *NativeClient) VerifyBody(v *maintenance.VerifiedService, raw []byte) error {
	if n == nil || n.Client == nil {
		return fail("maintenance_service_denied", 401)
	}
	return n.Client.VerifyBody(v, raw)
}
