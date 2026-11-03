package native

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Account bookmarks share the website's account-owned collection. They are
// distinct from the current Galaxy ID's /v2/reading-bookmarks collection.
func registerAccountBookmarkTools(server *mcp.Server, runtime *Runtime) {
	definitions := []struct {
		name, source, action, description string
		write                             bool
	}{
		{"galaxy_account_bookmarks", "galaxy_bookmarks", "query", "Read the explicitly selected linked account's private saved references, including its website bookmarks. Pass nextAfter unchanged for the same account and filters.", false},
		{"galaxy_account_bookmark_status", "galaxy_bookmark_status", "status", "Read one saved reference in the explicitly selected linked account. This does not grant access to its source.", false},
		{"galaxy_account_bookmark_command", "galaxy_bookmark_command", "command", "Save or remove a reference in the explicitly selected linked account. Keep the original operationId and reconcile an unknown result with the receipt before retrying.", true},
		{"galaxy_account_bookmark_receipt", "galaxy_bookmark_receipt", "receipt", "Read the original operation receipt for this explicitly selected linked account. Read current status to see its present state.", false},
	}
	contracts := remoteExtendedContracts()
	for _, definition := range definitions {
		d := definition
		schema := identityClone(uploadObject(contracts[d.source])["schema"])
		properties := uploadObject(schema["properties"])
		properties["accountId"] = materialUUID()
		if d.action == "query" {
			properties["after"] = map[string]any{"type": "string", "maxLength": 512, "pattern": `^rb2\.[A-Za-z0-9_-]+$`}
			properties["category"] = map[string]any{"type": "string", "enum": []string{"community", "private-chat"}}
		}
		required := []string{"accountId"}
		for _, value := range uploadRows(schema["required"]) {
			required = append(required, text(value))
		}
		schema["required"] = required
		addNativeTool(server, &mcp.Tool{Name: d.name, Description: d.description, InputSchema: schema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !d.write}}, "native_account_bookmark_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			decoded, err := jstext.DecodeJSON(request.Params.Arguments)
			if err != nil {
				return toolError(err)
			}
			input := uploadObject(decoded)
			if input == nil {
				return toolError(remoteFactsInvalid())
			}
			remoteDefaults(schema, input)
			if remoteChatValidate(schema, input) != nil {
				return toolError(remoteFactsInvalid())
			}
			account := text(input["accountId"])
			delete(input, "accountId")
			scope, err := runtime.store.ChoiceScope(ctx)
			if err != nil {
				return toolError(err)
			}
			value, err := runtime.Call(ctx, "/v2/account-bookmarks/"+d.action, input, ConnectionCallOptions{AccountID: account, ExpectedScope: &scope})
			if err != nil {
				result, encoding := toolResult(map[string]any{"error": runtimeErrorCode(err), "mayNeedReceiptReconciliation": d.write})
				if result != nil {
					result.IsError = true
				}
				return result, encoding
			}
			if d.action == "query" && value["accountId"] != account {
				return toolError(connectionFailure("native_account_bookmark_owner_mismatch"))
			}
			return toolResult(value)
		})
	}
}
