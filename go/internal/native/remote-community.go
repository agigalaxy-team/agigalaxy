package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/url"
	"sort"
	"strings"
)

type NativeCommunity struct{ runtime *Runtime }

func NewNativeCommunity(runtime *Runtime) *NativeCommunity { return &NativeCommunity{runtime} }
func remoteCommunityContracts() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(remoteCommunityContractsJSON), &value)
	return value
}
func remoteCommunityNormalize(name string, input any) (map[string]any, error) {
	contract := uploadObject(uploadObject(remoteCommunityContracts()["tools"])[name])
	if contract == nil {
		return nil, fault.New("native_community_input_invalid", 400)
	}
	schema := uploadObject(contract["schema"])
	inputSchema := identityClone(schema)
	if name == "galaxy_community_query" || name == "galaxy_community_owned" {
		query := uploadObject(uploadObject(inputSchema["properties"])["query"])
		delete(query, "maxLength")
	}
	if e := remoteChatValidate(inputSchema, input); e != nil {
		return nil, fault.New("native_community_input_invalid", 400)
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var result map[string]any
	if protocol.Decode(raw, &result) != nil || result == nil {
		return nil, fault.New("native_community_input_invalid", 400)
	}
	for key, value := range uploadObject(schema["properties"]) {
		property := uploadObject(value)
		if _, present := result[key]; !present {
			if value, present := property["default"]; present {
				result[key] = value
			}
		}
	}
	if name == "galaxy_community_query" || name == "galaxy_community_owned" {
		result["query"] = uploadTrim(text(result["query"]))
	}
	if !remoteChatTextLengths(schema, result) {
		return nil, fault.New("native_community_input_invalid", 400)
	}
	return result, nil
}
func remoteCommunityInputSchema(name string, schema map[string]any) map[string]any {
	if name == "galaxy_community_query" || name == "galaxy_community_owned" {
		schema = identityClone(schema)
		delete(uploadObject(uploadObject(schema["properties"])["query"]), "maxLength")
	}
	return schema
}
func (c *NativeCommunity) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	value, e := remoteCommunityNormalize(name, input)
	if e != nil {
		return nil, e
	}
	if name == "galaxy_community_topics" {
		request, cancel, generation, e := c.runtime.operation(ctx, false)
		if e != nil {
			return nil, e
		}
		defer cancel()
		if e = request.Err(); e != nil {
			return nil, e
		}
		result := uploadObject(remoteCommunityContracts()["topics"])
		return result, c.runtime.checkOperation(generation)
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	options := ConnectionCallOptions{ExpectedScope: &scope}
	path := ""
	switch name {
	case "galaxy_community_account_options":
		result, e := c.runtime.Call(ctx, "/v2/account-archives/accounts", map[string]any{}, options)
		if e != nil {
			return nil, e
		}
		items, ok := result["accounts"].([]any)
		if !ok {
			return nil, fault.New("native_account_options_unavailable", 409)
		}
		rows := []any{}
		for _, item := range items {
			row := uploadObject(item)
			if !controlUUID(row["id"]) {
				return nil, fault.New("native_account_options_unavailable", 409)
			}
			rows = append(rows, map[string]any{"id": row["id"]})
		}
		return map[string]any{"items": rows, "selectionRequired": len(rows) > 1}, nil
	case "galaxy_community_owned":
		path = "/v2/community/posts/owned"
		delete(value, "accountId")
	case "galaxy_community_query":
		path = "/v2/community/posts/query"
		delete(value, "accountId")
		options.Unauthenticated = true
	case "galaxy_community_replies":
		path = "/v2/community/replies/query"
		delete(value, "accountId")
		options.Unauthenticated = true
	case "galaxy_community_read":
		path = "/v2/community/posts/" + text(value["postId"])
		if version := text(value["versionId"]); version != "" {
			path += "/versions/" + version
		}
		options.Unauthenticated = true
		options.Method = "GET"
		value = nil
	case "galaxy_community_versions":
		path = "/v2/community/posts/" + text(value["postId"]) + "/versions"
		delete(value, "postId")
		delete(value, "accountId")
		options.Unauthenticated = true
	default:
		if !strings.HasPrefix(name, "galaxy_account_public_") {
			return nil, fault.New("native_community_input_invalid", 400)
		}
		options.Unauthenticated = true
		options.Method = "GET"
		if name == "galaxy_account_public_by_id" {
			path = "/v1/account/public/by-id/" + text(value["subjectId"])
		} else {
			path = "/v1/account/public/" + text(value["accountId"])
			suffix := map[string]string{"galaxy_account_public_ids": "ids", "galaxy_account_public_credentials": "credentials", "galaxy_account_public_posts": "posts"}[name]
			if suffix != "" {
				path += "/" + suffix
			}
		}
		if name != "galaxy_account_public_profile" {
			query := url.Values{}
			if after := text(value["after"]); after != "" {
				query.Set("after", after)
			}
			query.Set("limit", fmt.Sprint(value["limit"]))
			path += "?" + query.Encode()
		}
		value = nil
	}
	return c.runtime.Call(ctx, path, value, options)
}
func registerRemoteCommunityTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeCommunity(runtime)
	contracts := uploadObject(remoteCommunityContracts()["tools"])
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: remoteCommunityInputSchema(name, uploadObject(contract["schema"])), Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "native_community_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if e := protocol.Decode(request.Params.Arguments, &input); e != nil {
				return toolError(e)
			}
			value, e := client.Call(ctx, name, input)
			if e != nil {
				return toolError(e)
			}
			return toolResult(value)
		})
	}
}
