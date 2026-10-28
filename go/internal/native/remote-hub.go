package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

type NativeHubs struct{ runtime *Runtime }

func NewNativeHubs(runtime *Runtime) *NativeHubs { return &NativeHubs{runtime} }
func remoteHubContracts() map[string]any {
	var v map[string]any
	_ = protocol.Decode([]byte(remoteHubContractsJSON), &v)
	return v
}

var remoteHubPaths = map[string]string{
	"galaxy_hub_status": "/v2/hubs/status", "galaxy_hub_query": "/v2/hubs/query", "galaxy_hub_read": "/v2/hubs/read", "galaxy_hub_events": "/v2/hubs/events", "galaxy_hub_manage": "/v2/hubs/manage", "galaxy_hub_memberships": "/v2/hubs/memberships", "galaxy_hub_intake": "/v2/hubs/intake", "galaxy_hub_receipt": "/v2/hubs/receipt",
	"galaxy_hub_peering_party": "/v2/hubs/peering/party", "galaxy_hub_peering_connections": "/v2/hubs/peering/connections", "galaxy_hub_peering_sources": "/v2/hubs/peering/sources", "galaxy_hub_peering_events": "/v2/hubs/peering/events", "galaxy_hub_peering_read": "/v2/hubs/peering/read", "galaxy_hub_peering_list": "/v2/hubs/peering/list", "galaxy_hub_peering_preview": "/v2/hubs/peering/preview", "galaxy_hub_peering_query": "/v2/hubs/peering/query", "galaxy_hub_peering_receipt": "/v2/hubs/peering/receipt",
}

func remoteHubNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(remoteHubContracts()[name])
	if contract == nil || remoteHubPaths[name] == "" {
		return nil, remoteFactsInvalid()
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var v map[string]any
	if json.Unmarshal(raw, &v) != nil || v == nil {
		return nil, remoteFactsInvalid()
	}
	schema := uploadObject(contract["schema"])
	remoteDefaults(schema, v)
	if remoteChatValidate(schema, v) != nil {
		return nil, remoteFactsInvalid()
	}
	if name == "galaxy_hub_peering_sources" && (v["kind"] == "ci-proof-v2" && v["parentId"] != nil || v["kind"] != "ci-proof-v2" && v["parentId"] == nil) {
		return nil, remoteFactsInvalid()
	}
	if source := uploadObject(v["source"]); source["kind"] == "contribution-summary" {
		fields := uploadRows(source["fields"])
		seen := map[string]bool{}
		for _, raw := range fields {
			id := text(raw)
			if seen[id] {
				return nil, remoteFactsInvalid()
			}
			seen[id] = true
		}
		if !seen["eventType"] || !seen["actorId"] {
			return nil, remoteFactsInvalid()
		}
	}
	return v, nil
}
func (c *NativeHubs) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	if c == nil || c.runtime == nil {
		return nil, fault.New("native_runtime_unavailable", 503)
	}
	value, e := remoteHubNormalize(name, input)
	if e != nil {
		return nil, e
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	return c.runtime.Call(ctx, remoteHubPaths[name], value, ConnectionCallOptions{ExpectedScope: &scope})
}
func registerRemoteHubTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeHubs(runtime)
	contracts := remoteHubContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if protocol.Decode(request.Params.Arguments, &input) != nil {
				return toolError(remoteFactsInvalid())
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
