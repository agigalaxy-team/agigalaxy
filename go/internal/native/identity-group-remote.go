package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identitygroups"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

// NativeIdentityGroups uses the same captured identity and connection as other
// native tools. Signed payload/proof strings are never parsed and re-encoded for transmission.
type NativeIdentityGroups struct{ runtime *Runtime }

func NewNativeIdentityGroups(runtime *Runtime) *NativeIdentityGroups {
	return &NativeIdentityGroups{runtime}
}
func identityGroupContracts() map[string]any {
	var v map[string]any
	_ = protocol.Decode([]byte(identityGroupContractsJSON), &v)
	return v
}
func identityGroupNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(identityGroupContracts()[name])
	if contract == nil {
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
	if name == "galaxy_identity_group_source" {
		if _, e = identitygroups.ParseSourceSelection(raw); e != nil {
			return nil, e
		}
	}
	if name == "galaxy_identity_group_submit" {
		if _, e = identitygroups.ParseIntent([]byte(text(v["payloadJson"]))); e != nil {
			return nil, e
		}
		if _, e = identitygroups.ParseProof([]byte(text(v["proofJson"]))); e != nil {
			return nil, e
		}
	}
	return v, nil
}
func (c *NativeIdentityGroups) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	if c == nil || c.runtime == nil {
		return nil, fault.New("native_runtime_unavailable", 503)
	}
	v, e := identityGroupNormalize(name, input)
	if e != nil {
		return nil, e
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	options := ConnectionCallOptions{ExpectedScope: &scope}
	path := ""
	switch name {
	case "galaxy_identity_group_current":
		path = "/v2/identity-groups/current"
		options.Method = "GET"
		v = nil
	case "galaxy_identity_group_source":
		path = "/v2/identity-groups/source"
	case "galaxy_identity_group_submit":
		path = "/v2/identity-groups/submit"
	case "galaxy_identity_group_proposal":
		path = "/v2/identity-groups/operations/" + text(v["operationId"])
		options.Method = "GET"
		v = nil
	case "galaxy_identity_group_read":
		path = "/v2/identity-groups/" + text(v["groupId"])
		options.Method = "GET"
		v = nil
	case "galaxy_identity_group_query":
		path = "/v2/identity-groups/query"
	case "galaxy_identity_group_resolve":
		path = "/v2/identity-groups/resolve"
	case "galaxy_identity_group_receipt":
		path = "/v2/identity-groups/receipt"
	default:
		return nil, remoteFactsInvalid()
	}
	return c.runtime.Call(ctx, path, v, options)
}
func registerRemoteIdentityGroupTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeIdentityGroups(runtime)
	contracts := identityGroupContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(contract["description"]), InputSchema: contract["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
