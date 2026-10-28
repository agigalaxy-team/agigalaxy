package native

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Register only after explicit A2A configuration constructed the actual host.
// Closing this returned hook stops retained local previews/transports; it never
// reports remote task cancellation. No host is constructed by tools/list.
func registerNativeA2aTools(server *mcp.Server, tools *toolRuntime, host *NativeA2a) func() {
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
		body := map[string]any{"error": code, "reason": e.Error(), "originalOperationRetained": true}
		var operation *A2aOperationError
		if errors.As(e, &operation) {
			body["associationId"] = operation.AssociationID
			if operation.Reason != "" {
				body["error"] = operation.Reason
			} else {
				body["error"] = "A2A_OUTCOME_UNKNOWN"
			}
		}
		result, encode := toolResult(body)
		if result != nil {
			result.IsError = true
		}
		return result, encode
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
				encoded, _ := protocol.EncodeJS(choice)
				return tools.review(ctx, request, choice, fmt.Sprintf("仅执行所示外部 A2A peer、本人原 Attempt 与选中材料；结果仅为 peer 报告，不代表独立验证或验收。\n%s\n停止本机请求不表示远端已取消；未知结果保留原操作并核对，不自动重发。", encoded), func(scope *ChoiceScope) (any, error) {
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
