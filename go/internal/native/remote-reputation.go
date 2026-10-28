package native

import (
	"context"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/experiencereviews"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NativeReputation transports only the current, explicitly selected service's
// existing scoped facts and already signed writes. It issues no local rating,
// source permission, Consent or additional confirmation requirement.
type NativeReputation struct{ runtime *Runtime }

func NewNativeReputation(runtime *Runtime) *NativeReputation {
	return &NativeReputation{runtime: runtime}
}
func remoteReputationContracts() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(remoteReputationContractsJSON), &value)
	return value
}

var remoteReputationPaths = map[string]string{
	"galaxy_qualification_permission_plan":            "/v2/qualification/permission-requests/plan",
	"galaxy_qualification_permission_request":         "/v2/qualification/permission-requests/events",
	"galaxy_qualification_permission_requests":        "/v2/qualification/permission-requests/query",
	"galaxy_qualification_permission_request_read":    "/v2/qualification/permission-requests/read",
	"galaxy_qualification_permission_request_receipt": "/v2/qualification/permission-requests/receipt",
	"galaxy_qualification_calculation_receipt":        "/v2/qualification/calculation-receipt",
	"galaxy_qualification_calculation_owned":          "/v2/qualification/calculation-owned",
	"galaxy_experience_submit":                        "/v2/experience/submit",
	"galaxy_experience_read":                          "/v2/experience/read",
	"galaxy_qualification_v2_evaluate":                "/v2/qualification/evaluate",
	"galaxy_qualification_v2_candidates":              "/v2/qualification/candidates",
	"galaxy_qualification_calculation_permission":     "/v2/qualification/calculation-permissions",
	"galaxy_contribution_status":                      "/v2/contributions/status",
	"galaxy_contribution_sources":                     "/v2/contributions/sources",
	"galaxy_contribution_preview":                     "/v2/contributions/preview",
	"galaxy_contribution_publish":                     "/v2/contributions/publish",
	"galaxy_contribution_read":                        "/v2/contributions/read",
	"galaxy_honor_v2_query":                           "/v2/honor/query",
	"galaxy_honor_v2_ranking":                         "/v2/honor/ranking",
	"galaxy_requester_history_v2_query":               "/v2/requester-history/query",
	"galaxy_requester_history_v2_facts":               "/v2/requester-history/facts",
}

// Only the outer tool input is normalized. payloadJson remains the original
// string; the server owns its signed payload parser and current source rights.
func remoteReputationInput(contracts map[string]any, name string, input any) (map[string]any, error) {
	contract := psObject(contracts[name])
	if contract == nil {
		return nil, remoteFactsInvalid()
	}
	raw, e := jstext.EncodeJSON(input)
	if e != nil {
		return nil, e
	}
	decoded, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, remoteFactsInvalid()
	}
	value := psObject(decoded)
	if value == nil {
		return nil, remoteFactsInvalid()
	}
	schema := psObject(contract["schema"])
	remoteDefaults(schema, value)
	if remoteChatValidate(schema, value) != nil {
		return nil, remoteFactsInvalid()
	}
	switch name {
	case "galaxy_qualification_permission_plan":
		if _, e = qualification.ParsePlan(value); e != nil {
			return nil, remoteFactsInvalid()
		}
	case "galaxy_qualification_v2_evaluate":
		raw, e = jstext.EncodeJSON(value)
		if e != nil {
			return nil, e
		}
		if _, e = qualification.ParseQueryV2(raw); e != nil {
			return nil, remoteFactsInvalid()
		}
	case "galaxy_contribution_preview":
		if e = contributions.ValidatePreview(value); e != nil {
			return nil, remoteFactsInvalid()
		}
	case "galaxy_experience_read":
		if e = experiencereviews.ParseRead(value); e != nil {
			return nil, remoteFactsInvalid()
		}
	}
	return value, nil
}
func (c *NativeReputation) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	if c == nil || c.runtime == nil {
		return nil, fault.New("native_runtime_unavailable", 503)
	}
	value, e := remoteReputationInput(remoteReputationContracts(), name, input)
	if e != nil {
		return nil, e
	}
	path := remoteReputationPaths[name]
	if path == "" {
		return nil, remoteFactsInvalid()
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	return c.runtime.Call(ctx, path, value, ConnectionCallOptions{ExpectedScope: &scope})
}
func registerRemoteReputationTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeReputation(runtime)
	contracts := remoteReputationContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := psObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := jstext.DecodeJSON(request.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			value, e := client.Call(ctx, name, input)
			if e != nil {
				result, encoding := toolResult(map[string]any{"error": runtimeErrorCode(e), "mayNeedReceiptReconciliation": write})
				if result != nil {
					result.IsError = true
				}
				return result, encoding
			}
			return toolResult(value)
		})
	}
}
