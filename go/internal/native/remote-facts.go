package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"math"
	"sort"
	"strings"
	"time"
)

func remoteFactsContracts() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(remoteFactsContractsJSON), &value)
	return value
}
func remoteFactsInvalid() error { return fault.New("native_remote_input_invalid", 400) }
func remoteDefaults(schema map[string]any, value any) {
	if object, ok := value.(map[string]any); ok {
		for _, union := range []string{"anyOf", "oneOf"} {
			for _, branch := range uploadRows(schema[union]) {
				branch := uploadObject(branch)
				if branch["type"] == "object" || branch["properties"] != nil {
					remoteDefaults(branch, object)
				}
			}
		}
		for key, property := range uploadObject(schema["properties"]) {
			property := uploadObject(property)
			if _, present := object[key]; !present {
				if defaultValue, present := property["default"]; present {
					object[key] = defaultValue
				}
			}
			if child, present := object[key]; present {
				remoteDefaults(property, child)
			}
		}
	}
	if values, ok := value.([]any); ok {
		for _, child := range values {
			remoteDefaults(uploadObject(schema["items"]), child)
		}
	}
}
func remoteTrim(object map[string]any, key string) {
	if value, ok := object[key].(string); ok {
		object[key] = uploadTrim(value)
	}
}
func remoteNumber(value any) float64 {
	switch value := value.(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case json.Number:
		number, e := value.Float64()
		if e == nil {
			return number
		}
	}
	return math.NaN()
}
func remotePreferences(value map[string]any) bool {
	if value == nil {
		return true
	}
	seen := map[string]bool{}
	for _, item := range uploadRows(value["purposes"]) {
		purpose := text(item)
		if seen[purpose] {
			return false
		}
		seen[purpose] = true
	}
	for _, key := range []string{"functions"} {
		if values, ok := value[key].([]any); ok {
			for index, item := range values {
				if text, ok := item.(string); ok {
					values[index] = uploadTrim(text)
				}
			}
		}
	}
	return true
}
func remoteFactsNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(remoteFactsContracts()[name])
	if contract == nil {
		return nil, remoteFactsInvalid()
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, remoteFactsInvalid()
	}
	schema := uploadObject(contract["schema"])
	remoteDefaults(schema, value)
	if name == "galaxy_tasks_v2_query" || name == "galaxy_history_v2_query" {
		remoteTrim(value, "query")
	}
	if name == "galaxy_history_v2_query" {
		remoteTrim(uploadObject(value["context"]), "environment")
		window := uploadObject(value["timeWindow"])
		if window["kind"] == "custom" {
			from, e1 := time.Parse(time.RFC3339Nano, text(window["from"]))
			before, e2 := time.Parse(time.RFC3339Nano, text(window["before"]))
			if e1 != nil || e2 != nil || from.UnixMilli() >= before.UnixMilli() {
				return nil, remoteFactsInvalid()
			}
		}
		words := strings.FieldsFunc(text(value["query"]), func(point rune) bool { return uploadTrim(string(point)) == "" })
		if len(words) > 8 {
			return nil, remoteFactsInvalid()
		}
	}
	if name == "galaxy_task_v2_owner_control_prepare" {
		remoteTrim(value, "reason")
	}
	if name == "galaxy_task_material_prepare" {
		seen := map[string]bool{}
		for _, item := range uploadRows(value["selections"]) {
			selection := uploadObject(item)
			id := text(selection["materialId"])
			if remoteNumber(selection["end"]) <= remoteNumber(selection["start"]) || seen[id] {
				return nil, remoteFactsInvalid()
			}
			seen[id] = true
		}
	}
	if name == "galaxy_project_v2_preferences_save" {
		preferences := uploadObject(value["preferences"])
		if !remotePreferences(preferences) || !remotePreferences(uploadObject(preferences["temporary"])) {
			return nil, remoteFactsInvalid()
		}
	}
	if name == "galaxy_evidence_v2_submit" {
		event, e := verificationrecords.ParseEvent([]byte(text(value["payloadJson"])))
		if e != nil || event["kind"] != "evidence" {
			return nil, remoteFactsInvalid()
		}
	}
	if remoteChatValidate(schema, value) != nil {
		return nil, remoteFactsInvalid()
	}
	return value, nil
}
func remoteFactsInputSchema(name string, schema map[string]any) map[string]any {
	schema = identityClone(schema)
	// Both existing creation union branches are strict objects. MCP's Go SDK
	// requires this shared root type in addition to their unchanged anyOf.
	if schema["type"] == nil {
		schema["type"] = "object"
	}
	var walk func(map[string]any)
	walk = func(node map[string]any) {
		for key, property := range uploadObject(node["properties"]) {
			property := uploadObject(property)
			if isOne(key, "query", "environment", "reason") {
				delete(property, "minLength")
				delete(property, "maxLength")
			}
			if key == "functions" {
				item := uploadObject(property["items"])
				delete(item, "minLength")
				delete(item, "maxLength")
			}
		}
		for _, value := range node {
			if value, ok := value.(map[string]any); ok {
				walk(value)
			}
			if values, ok := value.([]any); ok {
				for _, value := range values {
					if value, ok := value.(map[string]any); ok {
						walk(value)
					}
				}
			}
		}
	}
	walk(schema)
	return schema
}
func remoteFactsRequest(name string, value map[string]any) (string, any, string, error) {
	method := "POST"
	path := ""
	body := any(value)
	switch name {
	case "galaxy_history_v2_query":
		path = "/v2/history/query"
	case "galaxy_case_v2_submit":
		path = "/v2/cases/events"
	case "galaxy_case_v2_receipt":
		path = "/v2/cases/events/receipt"
	case "galaxy_case_v2_read":
		id := text(value["caseId"])
		delete(value, "caseId")
		path = "/v2/cases/" + id + "/read"
	case "galaxy_intervention_responses_submit":
		path = "/v2/cases/intervention-responses"
	case "galaxy_task_create_link_case":
		id := text(value["taskId"])
		delete(value, "taskId")
		path = "/v2/tasks/" + id + "/case"
	case "galaxy_task_case_link_receipt":
		id := text(value["taskId"])
		delete(value, "taskId")
		path = "/v2/tasks/" + id + "/case-link/receipt"
	case "galaxy_evidence_v2_submit", "galaxy_verification_record_submit":
		path = "/v2/verification-records/submit"
	case "galaxy_verification_record_read":
		path = "/v2/verification-records/read"
	case "galaxy_verification_record_receipt":
		path = "/v2/verification-records/receipt"
	case "galaxy_evidence_status":
		path = "/v2/verification-records/status"
	default:
		return "", nil, "", remoteFactsInvalid()
	}
	return path, body, method, nil
}

type NativeFacts struct{ runtime *Runtime }

func NewNativeFacts(runtime *Runtime) *NativeFacts { return &NativeFacts{runtime} }
func (c *NativeFacts) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	return remoteBusinessCall(ctx, c.runtime, name, input, nil, remoteFactsRequest)
}
func remoteBusinessCall(ctx context.Context, runtime *Runtime, name string, input any, expected *ChoiceScope, request func(string, map[string]any) (string, any, string, error)) (map[string]any, error) {
	value, e := remoteFactsNormalize(name, input)
	if e != nil {
		return nil, e
	}
	scope, e := runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	if expected != nil && scope != *expected {
		return nil, fault.New("native_choice_binding_changed", 409)
	}
	path, body, method, e := request(name, value)
	if e != nil {
		return nil, e
	}
	return runtime.Call(ctx, path, body, ConnectionCallOptions{Method: method, ExpectedScope: &scope})
}
func registerRemoteFactsTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	registerRemoteBusinessTools(server, tools, runtime, func(name string) bool {
		return !strings.HasPrefix(name, "galaxy_project_v2_") && !strings.HasPrefix(name, "galaxy_task_v2_") && !isOne(name, "galaxy_tasks_v2_query", "galaxy_task_material_prepare", "galaxy_task_material_status", "galaxy_participation_v2_propose", "galaxy_participation_v2_event")
	}, remoteFactsRequest)
}
func registerRemoteBusinessTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime, selected func(string) bool, request func(string, map[string]any) (string, any, string, error)) {
	contracts := remoteFactsContracts()
	names := []string{}
	for name := range contracts {
		if selected(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: remoteFactsInputSchema(name, uploadObject(contract["schema"])), Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if protocol.Decode(req.Params.Arguments, &input) != nil {
				return toolError(remoteFactsInvalid())
			}
			if name == "galaxy_project_v2_preferences_save" {
				normalized, e := remoteFactsNormalize(name, input)
				if e != nil {
					return toolError(e)
				}
				raw, e := protocol.Encode(normalized)
				if e != nil {
					return toolError(e)
				}
				return tools.review(ctx, req, normalized, "本人确认保存该项目的准确发现范围偏好；全局关闭或暂停仍有效。不发布项目、不发送邀请。\n"+string(raw), func(scope *ChoiceScope) (any, error) {
					return remoteBusinessCall(ctx, runtime, name, normalized, scope, request)
				})
			}
			value, e := remoteBusinessCall(ctx, runtime, name, input, nil, request)
			if e != nil {
				result, encodeError := toolResult(map[string]any{"error": runtimeErrorCode(e), "mayNeedReceiptReconciliation": write})
				if result != nil {
					result.IsError = true
				}
				return result, encodeError
			}
			return toolResult(value)
		})
	}
}
