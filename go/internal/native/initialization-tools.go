package native

import (
	"context"
	"fmt"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerInitializationTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
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
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_initialize", Description: "Prepare the reviewed local identity and modules after the person's choice, then connect the selected service when configured. Preserve an existing identity and upload choices.", InputSchema: inputSchema}, "local_initialization_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input InitializationInput
		if e := protocol.Decode(req.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		preview, e := PreviewInitialization(input)
		if e != nil {
			return toolError(e)
		}
		message := initializationReviewMessage(preview)
		if runtime != nil {
			message += "\n初始化完成后将连接所选服务并登记本机设备；账户功能需要另行登录。"
		}
		return tools.review(ctx, req, input, message, func(ctx context.Context, scope *ChoiceScope) (any, error) {
			result, err := tools.store.Initialize(ctx, input, true, scope)
			if err != nil {
				return nil, err
			}
			if runtime == nil {
				result["serviceAccess"] = map[string]any{"state": "local-only"}
				return result, nil
			}
			// The local initialization result describes only its own writes; the
			// service outcome below is the authoritative connection projection.
			delete(result, "connectionCreated")
			connection, err := runtime.ConnectService(ctx)
			if err != nil {
				result["serviceAccess"] = map[string]any{"state": "disconnected", "error": runtimeErrorCode(err)}
				return result, nil
			}
			result["localOnly"] = false
			result["serviceAccess"] = map[string]any{"state": "ready", "connection": connection}
			return result, nil
		})
	})
}

func initializationReviewMessage(preview map[string]any) string {
	subject := "个人"
	if preview["subjectType"] == "organization" {
		subject = "组织"
	}
	names := map[string]string{"galaxy-id": "本机银河身份", "case-workspace": "工作记录", "consent-controls": "分享与授权", "agent-mcp": "AI宿主接入", "agent-guidance": "AI使用指引"}
	modules := []string{}
	for _, row := range uploadRows(preview["modules"]) {
		id := text(uploadObject(row)["id"])
		name := names[id]
		if name == "" {
			name = text(uploadObject(row)["title"])
		}
		modules = append(modules, "· "+name)
	}
	privacy := uploadObject(preview["uploadPrivacy"])
	sharing := map[string]string{"local-only": "仅本机保存", "history-overview": "工作概览", "work-content": "所选工作内容", "conversation-archive": "所选会话原件"}[text(privacy["level"])]
	if privacy["includeFullConversations"] == true {
		sharing += "，包含所选完整会话"
	}
	return fmt.Sprintf("身份类型：%s\n启用功能：\n%s\n联网后的分享范围选择：%s\n\n身份密钥保存在本机。已有身份会继续使用；初始化不会上传资料或调用模型。", subject, strings.Join(modules, "\n"), sharing)
}
