package native

import (
	"context"
	"errors"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Registration permits selected public service resolution. It never grants
// dispatch; original Native review is still required for every actual send.
// Closing stops local previews/transports and never reports remote cancellation.
func registerNativeA2aTools(server *mcp.Server, tools *toolRuntime, host *NativeA2a) func() {
	tools.pending = append(tools.pending, host.pendingInteractions)
	if host == nil {
		return func() {}
	}
	contracts := a2aToolContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	failed := func(e error) (*mcp.CallToolResult, error) {
		code := "a2a_operation_incomplete"
		var operation *A2aOperationError
		if errors.As(e, &operation) {
			if operation.Reason != "" {
				code = operation.Reason
			} else {
				code = "A2A_OUTCOME_UNKNOWN"
			}
		}
		return a2aFailure(e, code, false), nil
	}
	for _, name := range names {
		contract := uploadObject(contracts[name])
		schema := a2aClone(uploadObject(contract["schema"]))
		schema["type"] = "object"
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(contract["description"]), InputSchema: schema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: contract["write"] != true}}, "native_remote_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var raw map[string]any
			if protocol.Decode(request.Params.Arguments, &raw) != nil {
				return failed(a2aError("invalid input"))
			}
			input, e := a2aNormalize(name, raw)
			if e != nil {
				return failed(e)
			}
			switch name {
			case "galaxy_a2a_resolve":
				value, e := host.Resolve(ctx, input)
				if e != nil {
					return failed(e)
				}
				return toolResult(value)
			case "galaxy_a2a_peers":
				return toolResult(host.Peers())
			case "galaxy_a2a_read":
				value, e := host.Read(ctx, input)
				if e != nil {
					return failed(e)
				}
				return toolResult(value)
			case "galaxy_a2a_prepare":
				preview, e := host.Prepare(ctx, input)
				if e != nil {
					return failed(e)
				}
				if preview.value["state"] == "acknowledged" {
					return toolResult(preview.Value())
				}
				return toolResult(map[string]any{"operationId": preview.operationID, "preview": preview.Value(), "state": "local-preview", "remoteSubmitted": false})
			case "galaxy_a2a_abort_local":
				host.mu.Lock()
				preview := host.previews[text(input["operationId"])]
				host.mu.Unlock()
				value, e := host.Abort(preview)
				if e != nil {
					return failed(e)
				}
				return toolResult(value)
			case "galaxy_a2a_execute":
				host.mu.Lock()
				preview := host.previews[text(input["operationId"])]
				var state string
				if preview != nil {
					state = preview.state
				}
				expired := preview == nil || preview.expires <= host.options.Now().UnixMilli()
				host.mu.Unlock()
				if expired {
					return failed(a2aError("preview expired; read retained association"))
				}
				if e = preview.lease.check(ctx); e != nil {
					return failed(e)
				}
				if state == "running" {
					return toolResult(map[string]any{"state": "in-progress", "operationId": input["operationId"]})
				}
				if state != "prepared" {
					association, e := host.Read(ctx, map[string]any{"peerId": preview.peer.id, "action": "get", "associationId": preview.value["associationId"]})
					if e != nil {
						return failed(e)
					}
					return toolResult(map[string]any{"state": state, "association": association, "remoteResent": false})
				}
				choice := map[string]any{"operationId": input["operationId"], "preview": preview.Value()}

				return tools.review(ctx, request, choice, "将所选工作与材料交给下列外部服务处理。", func(ctx context.Context, scope *ChoiceScope) (any, error) {
					host.mu.Lock()
					state := preview.state
					host.mu.Unlock()
					if state != "prepared" {
						return map[string]any{"state": state, "remoteResent": false}, nil
					}
					return host.ExecuteReviewed(ctx, preview, scope)
				})
			}
			return failed(a2aError("unknown tool"))
		})
	}
	return host.Close
}
