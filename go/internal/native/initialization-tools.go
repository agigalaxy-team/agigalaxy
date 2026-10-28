package native

import (
	"context"
	"fmt"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerInitializationTools(server *mcp.Server, tools *toolRuntime) {
	enum := func(values ...string) any { return map[string]any{"type": "string", "enum": values} }
	inputSchema := objectSchema(map[string]any{
		"initializationPath": enum("personal-galaxy", "galaxy-worker", "galaxy-hub"),
		"profile":            enum("minimal", "coding-case", "agent-workspace"),
		"subjectType":        enum("person", "organization"),
		"modules":            map[string]any{"type": "array", "maxItems": 8, "items": map[string]any{"type": "string", "minLength": 2, "maxLength": 80}},
		"uploadPrivacy": objectSchema(map[string]any{
			"level":                    enum("local-only", "history-overview", "work-content", "conversation-archive"),
			"includeFullConversations": map[string]any{"type": "boolean"},
			"sessionIds":               map[string]any{"type": "array", "maxItems": 500, "items": stringSchema()},
		}, "level"),
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_initialize_preview", Description: "Preview existing local initialization choices; no files, keys, connection or upload are created.", InputSchema: inputSchema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "local_initialization_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input InitializationInput
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		result, e := PreviewInitialization(input)
		if e != nil {
			return toolError(e)
		}
		return toolResult(result)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_initialize", Description: "Prepare the reviewed local identity and modules after the person's choice. Preserve an existing identity; never connect, upload or call a model.", InputSchema: inputSchema}, "local_initialization_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input InitializationInput
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		preview, e := PreviewInitialization(input)
		if e != nil {
			return toolError(e)
		}
		encoded, e := protocol.Encode(preview)
		if e != nil {
			return toolError(e)
		}
		message := fmt.Sprintf("确认本机初始化选择：\n%s\n仅保存上述本机身份与模块选择，已有身份和密钥不重建；不会连接服务器、上传资料或调用模型。", encoded)
		return tools.review(ctx, req, input, message, func(scope *ChoiceScope) (any, error) { return tools.store.Initialize(ctx, input, true, scope) })
	})
}
