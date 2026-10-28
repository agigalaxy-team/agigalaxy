package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/url"
	"sort"
)

type NativeContacts struct{ runtime *Runtime }

func NewNativeContacts(runtime *Runtime) *NativeContacts { return &NativeContacts{runtime} }
func remoteSelectedContracts(raw string) map[string]any {
	var contracts map[string]any
	_ = protocol.Decode([]byte(raw), &contracts)
	return contracts
}
func (c *NativeContacts) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	if c == nil || c.runtime == nil {
		return nil, fault.New("native_runtime_unavailable", 503)
	}
	value, e := remoteSelectedInput(remoteSelectedContracts(remoteContactsContractsJSON), name, input)
	if e != nil {
		return nil, e
	}
	path, method, body := "", "POST", any(value)
	switch name {
	case "galaxy_contacts_v2_query":
		path = "/v2/contacts/query"
	case "galaxy_contact_v2_get":
		path = "/v2/contacts/" + text(value["contactId"])
		method = "GET"
		body = nil
	case "galaxy_contact_v2_event":
		path = "/v2/contacts"
	case "galaxy_recruitment_v2_query":
		path = "/v2/recruitment/query"
	case "galaxy_recruitment_v2_get":
		path = "/v2/recruitment/" + text(value["recruitmentId"])
		method = "GET"
		body = nil
	case "galaxy_recruitment_v2_event":
		path = "/v2/recruitment"
	case "galaxy_recruitment_v2_receipt":
		path = "/v2/recruitment/" + text(value["recruitmentId"]) + "/receipt?operationId=" + url.QueryEscape(text(value["operationId"])) + "&payloadHash=" + url.QueryEscape(text(value["payloadHash"]))
		method = "GET"
		body = nil
	default:
		return nil, remoteFactsInvalid()
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	return c.runtime.Call(ctx, path, body, ConnectionCallOptions{Method: method, ExpectedScope: &scope})
}

// These are ordinary existing scoped reads and already selected/signed writes.
// Only the original needsChoice contracts invoke the established local review.
func registerSelectedRemoteTools(server *mcp.Server, tools *toolRuntime, contracts map[string]any, run func(context.Context, string, any, *ChoiceScope) (any, error)) {
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := psObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "native_remote_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := jstext.DecodeJSON(req.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			value, e := remoteSelectedInput(contracts, name, input)
			if e != nil {
				return toolError(e)
			}
			if contract["needsChoice"] == true {
				raw, e := jstext.EncodeJSON(value)
				if e != nil {
					return toolError(e)
				}
				return tools.review(ctx, req, value, text(contract["description"])+"\n"+string(raw), func(scope *ChoiceScope) (any, error) { return run(ctx, name, value, scope) })
			}
			result, e := run(ctx, name, value, nil)
			if e != nil {
				out, encoding := toolResult(map[string]any{"error": runtimeErrorCode(e), "mayNeedReceiptReconciliation": write})
				if out != nil {
					out.IsError = true
				}
				return out, encoding
			}
			return toolResult(result)
		})
	}
}
func registerRemoteContactsTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeContacts(runtime)
	registerSelectedRemoteTools(server, tools, remoteSelectedContracts(remoteContactsContractsJSON), func(ctx context.Context, name string, input any, _ *ChoiceScope) (any, error) {
		return client.Call(ctx, name, input)
	})
}
