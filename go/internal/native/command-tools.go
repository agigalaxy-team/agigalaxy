package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"path/filepath"
)

func registerCommandTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	addNativeTool(server, &mcp.Tool{Name: "galaxy_command", Description: "Open the ordinary local menu, work history or upload settings. Existing installations are not initialized again.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}, InputSchema: objectSchema(map[string]any{"command": map[string]any{"type": "string", "enum": []string{"open", "help", "language", "status", "connect", "setup", "history", "work", "case", "privacy", "worker", "hub", "website"}, "default": "open"}, "language": map[string]any{"type": "string", "enum": []string{"zh-CN", "en-US"}}, "stage": integerSchema(1, 5, 1)})}, "native_command_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input CommandInput
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		value, e := runtime.Command(ctx, input)
		if e != nil {
			return toolError(e)
		}
		return toolResult(value)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_local_worker_identity_create", Description: "Create an Agent-subject identity in a separate local Worker directory. Keeps the normal client's ID/history unchanged. Does not start a Worker, model, network or cloud account.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}, InputSchema: objectSchema(map[string]any{"workerId": map[string]any{"type": "string", "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$"}}, "workerId")}, "local_worker_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			WorkerID string `json:"workerId"`
		}
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		message := fmt.Sprintf("本人确认创建独立本机 Worker Agent 身份。\nWorker：%s\n目录：%s\n保留普通客户端ID、密钥与履历。仅在该子目录创建或恢复原身份，不启动Worker、模型、联网或云端账户。", input.WorkerID, filepath.Join(tools.store.Directory, "workers", input.WorkerID))
		return tools.review(ctx, req, input, message, func(scope *ChoiceScope) (any, error) {
			return tools.store.InitializeWorkerIdentity(ctx, input.WorkerID, true, scope)
		})
	})
}
