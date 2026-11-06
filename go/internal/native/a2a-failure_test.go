package native

import (
	"errors"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestA2aFailurePresentationRetainsMachineState(t *testing.T) {
	cases := []struct {
		name                       string
		err                        error
		code, message, association string
		changed                    bool
	}{
		{"connection", connectionFailure("a2a_connection_changed"), "a2a_connection_changed", "当前连接已变化。", "", true},
		{"preview", connectionFailure("a2a_preview_expired"), "a2a_preview_expired", "这次确认已失效。", "", false},
		{"unknown-operation", &A2aOperationError{AssociationID: "original-association"}, "A2A_OUTCOME_UNKNOWN", "对方的处理结果尚未确认。", "original-association", false},
		{"peer-rejection", &A2aOperationError{AssociationID: "original-association", Reason: "peer_internal"}, "peer_internal", "这次外部协作未完成。", "original-association", false},
		{"unexpected", errors.New("private internal diagnostic"), "a2a_operation_incomplete", "这次外部协作未完成。", "", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			result := a2aFailure(test.err, test.code, test.changed)
			if !result.IsError || len(result.Content) != 1 {
				t.Fatal(result)
			}
			content, ok := result.Content[0].(*mcp.TextContent)
			if !ok || content.Text != test.message || strings.Contains(content.Text, "保留") {
				t.Fatal(result.Content)
			}
			data := uploadObject(result.StructuredContent)
			if data["error"] != test.code || data["originalOperationRetained"] != true {
				t.Fatal(data)
			}
			if test.association != "" && data["associationId"] != test.association {
				t.Fatal(data)
			}
			if test.changed && data["privateResultWithheld"] != true {
				t.Fatal(data)
			}
			if result.Meta["diagnosticReason"] != test.err.Error() {
				t.Fatal("diagnostic not retained in metadata")
			}
		})
	}
}
