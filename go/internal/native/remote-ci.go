package native

import (
	"context"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NativeCI submits the original selected CI observation or proof requests. It
// never runs a repository, creates a signature, or infers independent success.
type NativeCI struct{ runtime *Runtime }

func NewNativeCI(runtime *Runtime) *NativeCI { return &NativeCI{runtime: runtime} }
func remoteCIContracts() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(remoteCIContractsJSON), &value)
	return value
}

var remoteCIPaths = map[string]string{
	"galaxy_ci_v2_receipt":       "/v2/ci/receipts",
	"galaxy_ci_v2_observe":       "/v2/ci/requests",
	"galaxy_ci_v2_read":          "/v2/ci/requests/read",
	"galaxy_ci_v2_stop":          "/v2/ci/requests/revoke",
	"galaxy_ci_v2_proof_preview": "/v2/ci/proofs/preview",
	"galaxy_ci_v2_proof_publish": "/v2/ci/proofs/publish",
	"galaxy_ci_v2_proof_read":    "/v2/ci/proofs/read",
	"galaxy_ci_v2_proof_revoke":  "/v2/ci/proofs/revoke",
}

func (c *NativeCI) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	if c == nil || c.runtime == nil {
		return nil, fault.New("native_runtime_unavailable", 503)
	}
	value, e := remoteReputationInput(remoteCIContracts(), name, input)
	if e != nil {
		return nil, e
	}
	path := remoteCIPaths[name]
	if path == "" {
		return nil, remoteFactsInvalid()
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	return c.runtime.Call(ctx, path, value, ConnectionCallOptions{ExpectedScope: &scope})
}
func registerRemoteCITools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeCI(runtime)
	contracts := remoteCIContracts()
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
