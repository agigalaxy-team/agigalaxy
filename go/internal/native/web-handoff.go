package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/url"
	"strings"
	"sync"
	"unicode"
)

type NativeWebHandoff struct {
	runtime      *Runtime
	Navigation   *NativeNavigation
	Devices      *NativeDeviceHandoff
	OpenBrowser  func(context.Context, string) (map[string]any, error)
	mu, building sync.Mutex
	closed       bool
	entries      map[string]*webIdentityBridge
}

func NewNativeWebHandoff(runtime *Runtime) *NativeWebHandoff {
	runtime.mu.Lock()
	if runtime.deviceHandoff == nil {
		runtime.deviceHandoff = NewNativeDeviceHandoff(runtime)
	}
	if runtime.navigation == nil {
		runtime.navigation = NewNativeNavigation(runtime, NavigationOptions{})
	}
	navigation, devices := runtime.navigation, runtime.deviceHandoff
	runtime.mu.Unlock()
	return &NativeWebHandoff{runtime: runtime, Navigation: navigation, Devices: devices, OpenBrowser: navigationPlatformOpen, entries: map[string]*webIdentityBridge{}}
}
func webContracts() map[string]any { return remoteSelectedContracts(webHandoffContractsJSON) }
func webOrdered(value any, schema any) any {
	node := watchObject(schema)
	for _, key := range []string{"anyOf", "oneOf"} {
		for _, branch := range trustArray(node[key]) {
			if remoteChatValidate(watchObject(branch), value) == nil {
				return webOrdered(value, branch)
			}
		}
	}
	if array, ok := value.([]any); ok {
		out := []any{}
		for _, v := range array {
			out = append(out, webOrdered(v, node["items"]))
		}
		return out
	}
	object, ok := value.(map[string]any)
	if !ok {
		return value
	}
	properties, ok := node["properties"].(*protocol.OrderedObject)
	if !ok {
		return value
	}
	out := protocol.NewOrderedObject()
	for _, key := range properties.Keys() {
		if v, present := object[key]; present {
			out.Set(key, webOrdered(v, properties.Values()[key]))
		}
	}
	return out
}
func webHandoffInput(input any) (map[string]any, string, error) {
	values, e := trustJSON(input)
	if e != nil {
		return nil, "", e
	}
	navInput := map[string]any{"object": values["object"]}
	if v, ok := values["origin"]; ok {
		navInput["origin"] = v
	}
	nav, e := navigationNormalize(navInput)
	if e != nil {
		return nil, "", e
	}
	values["object"] = nav["object"]
	if continuation := psObject(values["continueWith"]); continuation != nil {
		if text(psObject(values["object"])["kind"]) != "task" {
			return nil, "", connectionFailure("web_identity_target_required")
		}
		if continuation["kind"] == "method-search" {
			continuation["query"] = uploadTrim(text(continuation["query"]))
			for _, r := range text(continuation["query"]) {
				if unicode.IsControl(r) || r >= 0x202a && r <= 0x202e || r >= 0x2066 && r <= 0x2069 {
					return nil, "", connectionFailure("web_identity_target_required")
				}
			}
		}
	}
	contracts := psObject(webContracts()["contracts"])
	values, e = remoteReputationInput(contracts, "galaxy_identity_web_connect", values)
	if e != nil {
		return nil, "", e
	}
	scopes, ok := connectionStrings(values["scopes"])
	if !ok || !connectionIncludes(scopes, "binding") {
		return nil, "", connectionFailure("web_identity_scopes_invalid")
	}
	seen := map[string]bool{}
	for _, scope := range scopes {
		if seen[scope] {
			return nil, "", connectionFailure("web_identity_scopes_invalid")
		}
		seen[scope] = true
	}
	if psObject(values["continueWith"])["kind"] == "method-search" && !connectionIncludes(scopes, "capsules") {
		return nil, "", connectionFailure("web_identity_scopes_invalid")
	}
	document, e := protocol.DecodeOrdered([]byte(webHandoffContractsJSON))
	if e != nil {
		return nil, "", e
	}
	schema := watchObject(watchObject(watchObject(document)["contracts"])["galaxy_identity_web_connect"])["schema"]
	raw, e := protocol.EncodeJS(webOrdered(values, schema))
	if e != nil {
		return nil, "", e
	}
	return values, identity.Digest(raw), nil
}
func webQuery(pairs ...string) string {
	out := []string{}
	for i := 0; i < len(pairs); i += 2 {
		encode := func(s string) string {
			return strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(s), "~", "%7E"), "%2A", "*")
		}
		out = append(out, encode(pairs[i])+"="+encode(pairs[i+1]))
	}
	return strings.Join(out, "&")
}
func webPublic(row map[string]any, location string) map[string]any {
	out := map[string]any{}
	for _, k := range []string{"handoffId", "navigationId", "subjectId", "targetPath", "expiresAt", "state"} {
		if v, ok := row[k]; ok {
			out[k] = v
		}
	}
	out["operationId"] = row["operationId"]
	out["deviceAuthorizationVerified"] = row["deviceAuthorizationVerified"] == true
	out["webConnectionReported"] = row["webConnectionReported"] == true
	out["websiteConnectionIndependentlyVerified"] = false
	out["transportAvailable"] = location != "" && row["transportClosed"] != true
	out["url"] = nil
	if location != "" && row["transportClosed"] != true {
		out["url"] = location
	}
	out["publicPacketsOnly"] = true
	out["originalWorkRef"] = "native-local-only"
	out["returnMode"] = "galaxy_return"
	return out
}
func (h *NativeWebHandoff) Prepare(ctx context.Context, input any) (map[string]any, error) {
	values, hash, e := webHandoffInput(input)
	if e != nil {
		return nil, e
	}
	h.building.Lock()
	defer h.building.Unlock()
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, connectionFailure("web_identity_transport_closed")
	}
	op, cancel, l, e := h.runtime.handoffLease(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if l.connection.selection.Active == nil {
		return nil, connectionFailure("native_identity_required")
	}
	id := text(values["requestId"])
	h.mu.Lock()
	existing := h.entries[id]
	h.mu.Unlock()
	if existing != nil {
		if existing.hash != hash || existing.lease.scope.Owner != l.scope.Owner {
			return nil, connectionFailure("web_identity_request_changed")
		}
		if e = existing.lease.check(ctx); e != nil {
			return nil, e
		}
		return webPublic(existing.Status(), existing.URL()), nil
	}
	key := "web-identity-connect-request:" + l.scope.Endpoint + ":" + id
	retained, e := l.read(op, key)
	if e != nil {
		return nil, e
	}
	if retained != nil {
		if retained["inputHash"] != hash || retained["subjectId"] != l.scope.Owner {
			return nil, connectionFailure("web_identity_request_changed")
		}
		saved, e := l.read(op, "web-identity-handoff:"+id)
		if e != nil {
			return nil, e
		}
		if saved == nil {
			saved = retained
		}
		out := webPublic(saved, "")
		if saved["state"] == nil {
			out["state"] = "transport-unavailable"
		}
		out["originalJournalPreserved"] = true
		out["transportRestarted"] = false
		out["nextAction"] = "query-original-device-operation"
		return out, nil
	}
	if l.connection.bindingID == "" {
		return nil, connectionFailure("native_connection_choice_required")
	}
	if !serviceConfigurationOrigin(l.scope.Endpoint) || !serviceConfigurationOrigin(h.runtime.config.Website) {
		return nil, connectionFailure("web_identity_context_invalid")
	}
	scopes, _ := connectionStrings(values["scopes"])
	bridge := &webIdentityBridge{host: h, lease: l, id: id, hash: hash, scopes: scopes, state: "ready", expires: h.runtime.connection.now().Unix() + 180}
	state, e := bridge.readControl(op)
	if e != nil {
		return nil, e
	}
	controller := deviceManager(state, l.scope.DeviceID)
	bridge.context = map[string]any{"endpoint": l.scope.Endpoint, "website": h.runtime.config.Website, "subjectId": l.scope.Owner, "controller": map[string]any{"deviceId": l.scope.DeviceID, "keyId": controller["key_id"], "epoch": state["epoch"], "chainHead": state["chainHead"]}, "scopes": values["scopes"]}
	if len(scopes) > 15 {
		return nil, connectionFailure("web_identity_context_invalid")
	}
	navInput := map[string]any{"object": values["object"]}
	if v, ok := values["origin"]; ok {
		navInput["origin"] = v
	}
	navigation, e := h.Navigation.Prepare(op, navInput)
	if e != nil {
		return nil, e
	}
	bridge.navigationID = text(navigation["navigationId"])
	bridge.object = psObject(values["object"])
	bridge.target = text(navigation["targetPath"])
	if continuation := psObject(values["continueWith"]); continuation != nil {
		task := text(bridge.object["id"])
		original := "/app/tasks/" + task + "?section=collaboration"
		if continuation["kind"] == "method-search" {
			bridge.target = "/app/search?" + webQuery("q", text(continuation["query"]), "sourceTask", task, "returnTo", original)
		} else {
			bridge.target = "/app/capsules/" + text(continuation["id"]) + "/versions/" + text(continuation["versionId"]) + "?" + webQuery("sourceTask", task, "returnTo", original)
		}
	}
	if bridge.target == "" || len(bridge.target) > 1500 || !strings.HasPrefix(bridge.target, "/app/") || strings.ContainsAny(bridge.target, "\\#") {
		return nil, connectionFailure("web_identity_target_required")
	}
	retained = map[string]any{"handoffId": id, "navigationId": bridge.navigationID, "subjectId": l.scope.Owner, "targetPath": bridge.target, "inputHash": hash, "state": "preparing", "operationId": nil}
	if e = l.update(op, key, func(map[string]any) (map[string]any, error) { return retained, nil }); e != nil {
		return nil, e
	}
	if e = bridge.start(); e != nil {
		return nil, e
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		_ = bridge.Close()
		return nil, connectionFailure("web_identity_transport_closed")
	}
	h.entries[id] = bridge
	h.mu.Unlock()
	if h.OpenBrowser != nil {
		if _, e = h.OpenBrowser(op, bridge.URL()); e != nil {
			_ = bridge.Close()
			return nil, e
		}
	}
	if e = l.check(op); e != nil {
		_ = bridge.Close()
		return nil, e
	}
	return webPublic(bridge.Status(), bridge.URL()), nil
}
func (h *NativeWebHandoff) Status(ctx context.Context, id string) (map[string]any, error) {
	if !handoffUUID(id) {
		return nil, connectionFailure("web_identity_request_unavailable")
	}
	h.mu.Lock()
	closed := h.closed
	entry := h.entries[id]
	h.mu.Unlock()
	if closed {
		return nil, connectionFailure("web_identity_transport_closed")
	}
	op, cancel, l, e := h.runtime.handoffLease(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if entry != nil {
		if entry.lease.scope.Owner != l.scope.Owner {
			return nil, connectionFailure("web_identity_request_changed")
		}
		if e = entry.lease.check(op); e != nil {
			return nil, e
		}
		return webPublic(entry.Status(), entry.URL()), nil
	}
	retained, e := l.read(op, "web-identity-connect-request:"+l.scope.Endpoint+":"+id)
	if e != nil {
		return nil, e
	}
	if retained == nil || retained["subjectId"] != l.scope.Owner {
		return nil, connectionFailure("web_identity_request_unavailable")
	}
	row, e := l.read(op, "web-identity-handoff:"+id)
	if e != nil {
		return nil, e
	}
	if row == nil {
		row = retained
	}
	out := webPublic(row, "")
	out["originalJournalPreserved"] = true
	out["transportRestarted"] = false
	return out, nil
}
func (h *NativeWebHandoff) Close() error {
	h.mu.Lock()
	h.closed = true
	h.mu.Unlock()
	h.building.Lock()
	defer h.building.Unlock()
	h.mu.Lock()
	entries := []*webIdentityBridge{}
	for _, entry := range h.entries {
		entries = append(entries, entry)
	}
	h.mu.Unlock()
	var first error
	for _, entry := range entries {
		if e := entry.Close(); e != nil && first == nil {
			first = e
		}
	}
	return first
}
func registerNativeWebHandoffTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) func() {
	host := NewNativeWebHandoff(runtime)
	for _, name := range []string{"galaxy_identity_web_connect", "galaxy_identity_web_connect_status"} {
		contract := psObject(psObject(webContracts()["contracts"])[name])
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: contract["readOnlyHint"] == true}}, "web_identity_operation_failed", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			var out map[string]any
			e := protocol.Decode(req.Params.Arguments, &input)
			if e == nil {
				if name == "galaxy_identity_web_connect" {
					out, e = host.Prepare(ctx, input)
				} else {
					out, e = host.Status(ctx, text(input["handoffId"]))
				}
			}
			if e != nil {
				result, encoding := toolResult(map[string]any{"error": webCode(e), "originalOperationPreserved": true})
				if result != nil {
					result.IsError = true
				}
				return result, encoding
			}
			return toolResult(out)
		})
	}
	return func() { _ = host.Close() }
}
