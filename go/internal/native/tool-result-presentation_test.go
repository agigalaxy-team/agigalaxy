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
	var data map[string]any
	nativeTestDecodeResult(t, result, &data)
	return data
}

// Decode the MCP wire result without treating human-readable content as JSON.
// Legacy internal results still expose JSON only through text content.
func nativeTestDecodeResult(t *testing.T, result *mcp.CallToolResult, out any) {
	t.Helper()
	_, array := out.(*[]any)
	if err := protocol.Decode(nativeTestResultBytes(t, result, array), out); err != nil {
		t.Fatalf("invalid machine result: %v", err)
	}
}

func nativeTestResultBytes(t *testing.T, result *mcp.CallToolResult, array bool) []byte {
	t.Helper()
	if result == nil {
		t.Fatal("missing tool result")
	}
	if result.StructuredContent != nil {
		raw, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		if array {
			var wrapper map[string]json.RawMessage
			if json.Unmarshal(raw, &wrapper) == nil && wrapper["items"] != nil {
				return wrapper["items"]
			}
		}
		return raw
	}
	if len(result.Content) != 1 {
		t.Fatalf("missing structured or legacy JSON result: %#v", result)
	}
	content, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("legacy result is not text: %#v", result)
	}
	return []byte(content.Text)
}

func TestClientResultKeepsOriginalWireValues(t *testing.T) {
	result := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: `{"slice":"\ud83d","number":9007199254740993}`}}}
	shown := presentNativeToolResult(result)
	raw, err := json.Marshal(shown.StructuredContent)
	if err != nil || !strings.Contains(string(raw), `\ud83d`) || !strings.Contains(string(raw), "9007199254740993") {
		t.Fatal(string(raw), err)
	}
}
