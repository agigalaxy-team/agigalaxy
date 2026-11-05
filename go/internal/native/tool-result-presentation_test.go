package native

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestClientResultKeepsMachineDataWithoutPrintingDiagnostics(t *testing.T) {
	result, _ := toolError(fault.New("native_connection_selection_changed", 409))
	original := result.Content[0].(*mcp.TextContent).Text
	shown := presentNativeToolResult(result)
	if clientResultData(t, shown)["error"] != "native_connection_selection_changed" {
		t.Fatal("the host lost the actual error")
	}
	for _, content := range shown.Content {
		if text, ok := content.(*mcp.TextContent); ok && strings.Contains(text.Text, "native_connection_selection_changed") {
			t.Fatal("internal error was displayed")
		}
	}
	if result.Content[0].(*mcp.TextContent).Text != original {
		t.Fatal("presenting a result changed the saved original")
	}
	data := map[string]any{"items": []any{map[string]any{"title": "讨论编辑器配置", "body": "保留使用者原文", "operationId": "private-operation"}}, "diagnostics": map[string]any{"text": "internal diagnostic", "hash": "private-hash"}}
	read, _ := toolResult(data)
	read = presentNativeToolResult(read)
	var content strings.Builder
	for _, item := range read.Content {
		if part, ok := item.(*mcp.TextContent); ok {
			content.WriteString(part.Text)
		}
	}
	if !strings.Contains(content.String(), "保留使用者原文") || strings.Contains(content.String(), "internal diagnostic") || strings.Contains(content.String(), "private-operation") {
		t.Fatal(content.String())
	}
	if clientResultData(t, read)["diagnostics"] == nil {
		t.Fatal("machine diagnostics were discarded")
	}
}

func TestClientConfirmationKeepsChosenContentAndDoesNotInventCompletion(t *testing.T) {
	input := map[string]any{"title": "分享工作记录", "text": `{"example":"用户原文"}`, "recipientNames": []any{"林舟"}, "operationId": "internal-operation", "payloadHash": "internal-hash"}
	message := userChoiceMessage("galaxy_native_authorize", input, "分享下列内容。")
	for _, wanted := range []string{"林舟", "用户原文"} {
		if !strings.Contains(message, wanted) {
			t.Fatal(message)
		}
	}
	for _, unwanted := range []string{"internal-operation", "internal-hash", "payloadHash"} {
		if strings.Contains(message, unwanted) {
			t.Fatal(message)
		}
	}
	if strings.Contains(userChoiceOutcome(map[string]any{"state": "accepted"}), "完成") {
		t.Fatal("acceptance became completion")
	}
	if userChoiceOutcome(map[string]any{"settings": map[string]any{"enabled": true}}) != "设置已保存。" {
		t.Fatal("saved settings did not have their actual result")
	}
}

func clientResultData(t *testing.T, result *mcp.CallToolResult) map[string]any {
	t.Helper()
	raw, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := protocol.Decode(raw, &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestClientResultKeepsOriginalWireValues(t *testing.T) {
	result := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: `{"slice":"\ud83d","number":9007199254740993}`}}}
	shown := presentNativeToolResult(result)
	raw, err := json.Marshal(shown.StructuredContent)
	if err != nil || !strings.Contains(string(raw), `\ud83d`) || !strings.Contains(string(raw), "9007199254740993") {
		t.Fatal(string(raw), err)
	}
}
