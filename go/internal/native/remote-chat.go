package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/jsonschema-go/jsonschema"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

type NativeChat struct{ runtime *Runtime }

func NewNativeChat(runtime *Runtime) *NativeChat { return &NativeChat{runtime} }
func remoteChatContracts() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(remoteChatContractsJSON), &value)
	return value
}
func remoteChatInvalid() error { return fault.New("native_chat_input_invalid", 400) }
func remoteChatInputSchema(name string, schema map[string]any) map[string]any {
	if name == "galaxy_chat_history" {
		schema = identityClone(schema)
		limit := uploadObject(uploadObject(schema["properties"])["limit"])
		delete(limit, "type")
		delete(limit, "minimum")
		delete(limit, "maximum")
	}
	if name == "galaxy_chat_create" {
		schema = identityClone(schema)
		title := uploadObject(uploadObject(schema["properties"])["title"])
		delete(title, "minLength")
		delete(title, "maxLength")
	}
	return schema
}
func remoteChatValidate(schema map[string]any, input any) error {
	raw, e := protocol.Encode(schema)
	if e != nil {
		return e
	}
	var parsed jsonschema.Schema
	if json.Unmarshal(raw, &parsed) != nil {
		return remoteChatInvalid()
	}
	resolved, e := parsed.Resolve(nil)
	if e != nil {
		return e
	}
	raw, e = protocol.Encode(input)
	if e != nil {
		return remoteChatInvalid()
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil || resolved.Validate(&decoded) != nil {
		return remoteChatInvalid()
	}
	return nil
}
func remoteChatTextLengths(schema map[string]any, value any) bool {
	if text, ok := value.(string); ok {
		if max, ok := schema["maxLength"]; ok && int64(utf8.RuneCountInString(text)) > integer(max) {
			return false
		}
		if min, ok := schema["minLength"]; ok && int64(utf8.RuneCountInString(text)) < integer(min) {
			return false
		}
	}
	if object, ok := value.(map[string]any); ok {
		properties := uploadObject(schema["properties"])
		for key, value := range object {
			if !remoteChatTextLengths(uploadObject(properties[key]), value) {
				return false
			}
		}
	}
	if values, ok := value.([]any); ok {
		for _, value := range values {
			if !remoteChatTextLengths(uploadObject(schema["items"]), value) {
				return false
			}
		}
	}
	return true
}
func remoteChatJSString(value any) string {
	switch value := value.(type) {
	case nil:
		return ""
	case string:
		return value
	case []any:
		parts := []string{}
		for _, item := range value {
			parts = append(parts, remoteChatJSString(item))
		}
		return strings.Join(parts, ",")
	case bool:
		if value {
			return "true"
		}
		return "false"
	case json.Number:
		return string(value)
	default:
		return "[object Object]"
	}
}
func remoteChatCoerceNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case bool:
		if v {
			return 1, true
		}
		return 0, true
	case nil:
		return 0, true
	case json.Number:
		n, e := v.Float64()
		return n, e == nil
	case float64:
		return v, true
	}
	raw := uploadTrim(remoteChatJSString(value))
	if raw == "" {
		return 0, true
	}
	if len(raw) > 2 && raw[0] == '0' && isOne(strings.ToLower(raw[1:2]), "x", "b", "o") {
		base := 16
		if raw[1] == 'b' || raw[1] == 'B' {
			base = 2
		}
		if raw[1] == 'o' || raw[1] == 'O' {
			base = 8
		}
		n, e := strconv.ParseUint(raw[2:], base, 64)
		return float64(n), e == nil
	}
	n, e := strconv.ParseFloat(raw, 64)
	return n, e == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
}
func remoteChatNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(remoteChatContracts()[name])
	if contract == nil {
		return nil, remoteChatInvalid()
	}
	schema := uploadObject(contract["schema"])
	if e := remoteChatValidate(remoteChatInputSchema(name, schema), input); e != nil {
		return nil, e
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var out map[string]any
	if protocol.Decode(raw, &out) != nil || out == nil {
		return nil, remoteChatInvalid()
	}
	for key, value := range uploadObject(schema["properties"]) {
		property := uploadObject(value)
		if _, present := out[key]; !present {
			if defaultValue, present := property["default"]; present {
				out[key] = defaultValue
			}
		}
	}
	if name == "galaxy_chat_create" {
		out["title"] = uploadTrim(text(out["title"]))
		if text(out["title"]) == "" {
			return nil, remoteChatInvalid()
		}
	}
	if name == "galaxy_chat_history" {
		number, ok := remoteChatCoerceNumber(out["limit"])
		if !ok || number < 1 || number > 100 || number != math.Trunc(number) {
			return nil, remoteChatInvalid()
		}
		out["limit"] = int(number)
		if _, hasBefore := out["before"]; hasBefore && out["latest"] != true {
			return nil, remoteChatInvalid()
		}
		if out["latest"] == true && out["after"] != "0" {
			return nil, remoteChatInvalid()
		}
	}
	if name == "galaxy_chat_send" && uploadTrim(text(out["text"])) == "" && len(uploadRows(out["attachments"])) == 0 {
		return nil, remoteChatInvalid()
	}
	if !remoteChatTextLengths(schema, out) {
		return nil, remoteChatInvalid()
	}
	return out, nil
}
func remoteChatChoice(name string) bool {
	return isOne(name, "galaxy_chat_create", "galaxy_chat_vote", "galaxy_chat_propose", "galaxy_chat_accept_invitation", "galaxy_chat_leave", "galaxy_chat_agent_grant")
}
func remoteChatPath(name string, input map[string]any) (string, map[string]any, error) {
	globals := map[string]string{"galaxy_chat_rooms": "rooms/query", "galaxy_chat_create": "rooms/create", "galaxy_chat_invitations": "invitations/query", "galaxy_chat_export_owned": "export/owned"}
	if path := globals[name]; path != "" {
		return "/v2/chat/" + path, input, nil
	}
	room := text(input["roomId"])
	delete(input, "roomId")
	actions := map[string]string{"galaxy_chat_room": "read", "galaxy_chat_join_preview": "join-preview", "galaxy_chat_join": "join", "galaxy_chat_agent_participants": "agent-participants", "galaxy_chat_history": "history", "galaxy_chat_send": "send", "galaxy_chat_message_status": "receipt", "galaxy_chat_decisions": "decisions", "galaxy_chat_propose": "propose", "galaxy_chat_vote": "vote", "galaxy_chat_accept_invitation": "accept", "galaxy_chat_leave": "leave", "galaxy_chat_agent_cursor": "cursor", "galaxy_chat_agent_grants": "agent-grants", "galaxy_chat_agent_revoke": "agent-revoke", "galaxy_chat_agent_grant": "agent-grant"}
	if name == "galaxy_chat_edit" || name == "galaxy_chat_retract" {
		message := text(input["messageId"])
		delete(input, "messageId")
		action := "edit"
		if name == "galaxy_chat_retract" {
			action = "retract"
		}
		return "/v2/chat/rooms/" + room + "/messages/" + message + "/" + action, input, nil
	}
	if name == "galaxy_chat_agent_cursor" {
		input["kind"] = "agent"
	}
	if action := actions[name]; action != "" {
		return "/v2/chat/rooms/" + room + "/" + action, input, nil
	}
	return "", nil, remoteChatInvalid()
}

// Call performs one original request. Unknown writes retain caller-provided
// operation/clientMessage/grant IDs; this client never creates or retries one.
func (c *NativeChat) Call(ctx context.Context, name string, input any, expected *ChoiceScope) (map[string]any, error) {
	value, e := remoteChatNormalize(name, input)
	if e != nil {
		return nil, e
	}
	if remoteChatChoice(name) && expected == nil {
		return nil, fault.New("native_choice_binding_required", 409)
	}
	operation, cancel, lease, e := c.runtime.identityLease(ctx, true)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if expected != nil && lease.scope != *expected {
		return nil, fault.New("native_choice_binding_changed", 409)
	}
	scope := lease.scope
	path, body, e := remoteChatPath(name, value)
	if e != nil {
		return nil, e
	}
	call := func(path string, body any) (map[string]any, error) {
		if e := lease.check(operation); e != nil {
			return nil, e
		}
		result, e := c.runtime.Call(operation, path, body, ConnectionCallOptions{ExpectedScope: &scope})
		if check := lease.check(operation); check != nil {
			return nil, check
		}
		return result, e
	}
	if name == "galaxy_chat_agent_grant" {
		room := strings.TrimSuffix(path, "agent-grant")
		old, e := call(room+"agent-grants", map[string]any{"grantId": body["grantId"]})
		if e != nil {
			return nil, e
		}
		for _, row := range uploadRows(old["items"]) {
			receipt := uploadObject(row)
			if receipt["grantId"] != body["grantId"] {
				continue
			}
			if receipt["bindingId"] != lease.connection.bindingID || receipt["mode"] != body["mode"] || receipt["primaryResponder"] != body["primaryResponder"] || integer(receipt["expiresAt"]) != integer(body["expiresAt"]) {
				return nil, fault.New("agent_grant_original_scope_changed", 409)
			}
			result := identityClone(receipt)
			result["reconciled"], result["hostRuntimeStarted"] = true, false
			return result, nil
		}
		body["bindingId"] = lease.connection.bindingID
	}
	return call(path, body)
}
