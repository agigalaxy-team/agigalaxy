package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

// NativeMaterials is only the original current-binding Context, Configuration
// and Capsule consumer. Exact signed payloadJson strings remain unchanged.
type NativeMaterials struct{ runtime *Runtime }

func NewNativeMaterials(r *Runtime) *NativeMaterials { return &NativeMaterials{runtime: r} }
func remoteMaterialContracts() map[string]any {
	var out map[string]any
	_ = protocol.Decode([]byte(remoteMaterialContractsJSON), &out)
	return out
}

var remoteMaterialPaths = map[string]string{
	"galaxy_context_v2_query": "/v2/context/query", "galaxy_context_v2_grant": "/v2/context/grants", "galaxy_context_v2_receipt": "/v2/context/receipt",
	"galaxy_configuration_v2_submit": "/v2/configurations/events", "galaxy_configuration_v2_read": "/v2/configurations/read", "galaxy_configuration_v2_query": "/v2/configurations/query", "galaxy_configuration_v2_versions": "/v2/configurations/versions", "galaxy_configuration_v2_receipt": "/v2/configurations/receipt",
	"galaxy_capsule_v2_receipt": "/v2/capsules/receipt", "galaxy_capsule_v2_versions": "/v2/capsules/versions", "galaxy_capsule_v2_permissions": "/v2/capsules/permissions/query", "galaxy_capsule_v2_preview": "/v2/capsules/preview", "galaxy_capsule_v2_publish": "/v2/capsules/events", "galaxy_capsule_v2_read": "/v2/capsules/read", "galaxy_capsule_v2_query": "/v2/capsules/query", "galaxy_capsule_v2_use": "/v2/capsules/uses", "galaxy_capsule_v2_uses": "/v2/capsules/uses/query", "galaxy_capsule_v2_permission": "/v2/capsules/permissions", "galaxy_capsule_v2_permission_read": "/v2/capsules/permissions/read",
}
var remoteCapsuleInputKinds = map[string]string{"galaxy_capsule_v2_receipt": "receipt", "galaxy_capsule_v2_versions": "versions", "galaxy_capsule_v2_permissions": "permissions-query", "galaxy_capsule_v2_preview": "preview", "galaxy_capsule_v2_read": "read", "galaxy_capsule_v2_query": "query", "galaxy_capsule_v2_uses": "uses-query", "galaxy_capsule_v2_permission_read": "permission-read"}

func remoteMaterialNormalize(name string, input any) (map[string]any, error) {
	contract := psObject(remoteMaterialContracts()[name])
	if contract == nil {
		return nil, remoteFactsInvalid()
	}
	raw, e := jstext.EncodeJSON(input)
	if e != nil {
		return nil, e
	}
	v, e := jstext.DecodeJSON(raw)
	value := psObject(v)
	if e != nil || value == nil {
		return nil, remoteFactsInvalid()
	}
	schema := psObject(contract["schema"])
	remoteDefaults(schema, value)
	if remoteChatValidate(schema, value) != nil {
		return nil, remoteFactsInvalid()
	}
	if kind := remoteCapsuleInputKinds[name]; kind != "" {
		raw, e = jstext.EncodeJSON(value)
		if e != nil {
			return nil, e
		}
		return capsules.ParseRequestV2(kind, raw)
	}
	return value, nil
}
func (c *NativeMaterials) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	if c == nil || c.runtime == nil {
		return nil, fault.New("native_runtime_unavailable", 503)
	}
	value, e := remoteMaterialNormalize(name, input)
	if e != nil {
		return nil, e
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	options := ConnectionCallOptions{ExpectedScope: &scope}
	path := remoteMaterialPaths[name]
	switch name {
	case "galaxy_context_v2_get":
		path = "/v2/context/" + text(value["grantId"])
		if value["metadataOnly"] == true {
			path += "/metadata"
		}
		value = nil
		options.Method = "GET"
	case "galaxy_context_v2_event":
		path = "/v2/context/" + text(value["grantId"]) + "/events"
		delete(value, "grantId")
	}
	if path == "" {
		return nil, remoteFactsInvalid()
	}
	return c.runtime.Call(ctx, path, value, options)
}
func registerRemoteMaterialTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeMaterials(runtime)
	contracts := remoteMaterialContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := psObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := jstext.DecodeJSON(req.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			out, e := client.Call(ctx, name, input)
			if e != nil {
				result, encoding := toolResult(map[string]any{"error": runtimeErrorCode(e), "mayNeedReceiptReconciliation": write})
				if result != nil {
					result.IsError = true
				}
				return result, encoding
			}
			return toolResult(out)
		})
	}
}
