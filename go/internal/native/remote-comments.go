package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

type NativeComments struct{ runtime *Runtime }

func NewNativeComments(runtime *Runtime) *NativeComments { return &NativeComments{runtime} }
func remoteCommentsContracts() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(remoteCommentsContractsJSON), &value)
	return value
}
func remoteCommentsInputSchema(name string, schema map[string]any) map[string]any {
	schema = identityClone(schema)
	if name == "galaxy_comments_query" {
		delete(uploadObject(uploadObject(schema["properties"])["query"]), "maxLength")
	}
	return schema
}
func remoteCommentsNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(remoteCommentsContracts()[name])
	if contract == nil {
		return nil, remoteFactsInvalid()
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, remoteFactsInvalid()
	}
	schema := uploadObject(contract["schema"])
	remoteDefaults(schema, value)
	if name == "galaxy_comments_query" {
		remoteTrim(value, "query")
	}
	if remoteChatValidate(schema, value) != nil {
		return nil, remoteFactsInvalid()
	}
	return value, nil
}
func remoteCommentsRequest(name string, value map[string]any) (string, any, string, error) {
	method := "POST"
	body := any(value)
	path := ""
	switch name {
	case "galaxy_comments_query":
		path = "/v2/comments/query"
	case "galaxy_comment_get":
		path = "/v2/comments/" + text(value["commentId"])
		method = "GET"
		body = nil
	case "galaxy_comment_submit":
		path = "/v2/comments"
	case "galaxy_comment_receipt":
		path = "/v2/comments/receipt"
	case "galaxy_comment_governance_config":
		path = "/v2/comment-governance/config"
		method = "GET"
		body = nil
	case "galaxy_comment_governance_query":
		path = "/v2/comment-governance/query"
	case "galaxy_comment_report":
		path = "/v2/comment-governance/reports"
	case "galaxy_comment_governance_event":
		id := text(value["reportId"])
		delete(value, "reportId")
		path = "/v2/comment-governance/" + id + "/events"
	case "galaxy_comment_governance_receipt":
		path = "/v2/comment-governance/receipt"
	default:
		return "", nil, "", remoteFactsInvalid()
	}
	return path, body, method, nil
}
func (c *NativeComments) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	value, e := remoteCommentsNormalize(name, input)
	if e != nil {
		return nil, e
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	path, body, method, e := remoteCommentsRequest(name, value)
	if e != nil {
		return nil, e
	}
	return c.runtime.Call(ctx, path, body, ConnectionCallOptions{Method: method, ExpectedScope: &scope})
}
func registerRemoteCommentTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeComments(runtime)
	contracts := remoteCommentsContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: remoteCommentsInputSchema(name, uploadObject(contract["schema"])), Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if protocol.Decode(request.Params.Arguments, &input) != nil {
				return toolError(remoteFactsInvalid())
			}
			value, e := client.Call(ctx, name, input)
			if e != nil {
				result, encodeError := toolResult(map[string]any{"error": runtimeErrorCode(e), "mayNeedReceiptReconciliation": write})
				if result != nil {
					result.IsError = true
				}
				return result, encodeError
			}
			return toolResult(value)
		})
	}
}
