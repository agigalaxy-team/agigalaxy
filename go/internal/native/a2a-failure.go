package native

import (
	"errors"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// a2aFailure keeps stable machine data separate from the user-facing message.
func a2aFailure(e error, code string, changed bool) *mcp.CallToolResult {
	body := map[string]any{"error": code, "originalOperationRetained": true}
	if changed {
		body["privateResultWithheld"] = true
	}
	message := "这次外部协作未完成。"
	var operation *A2aOperationError
	if errors.As(e, &operation) {
		body["associationId"] = operation.AssociationID
		if operation.Reason == "" {
			message = "对方的处理结果尚未确认。"
		}
	}
	if e != nil && e.Error() == "A2A: preview expired; read retained association" {
		message = "这次确认已失效。"
	}
	messageCode := code
	if actual := runtimeErrorCode(e); actual == "a2a_connection_changed" || actual == "a2a_preview_changed_or_expired" || actual == "a2a_preview_expired" || actual == "a2a_preview_unavailable" {
		messageCode = actual
	}
	switch messageCode {
	case "a2a_connection_changed":
		message = "当前连接已变化。"
	case "a2a_preview_changed_or_expired", "a2a_preview_expired", "a2a_preview_unavailable":
		message = "这次确认已失效。"
	case "A2A_OUTCOME_UNKNOWN":
		message = "对方的处理结果尚未确认。"
	}
	meta := mcp.Meta{}
	if e != nil {
		meta["diagnosticReason"] = e.Error()
	}
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}, StructuredContent: body, Meta: meta}
}
