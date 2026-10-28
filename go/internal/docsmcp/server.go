package docsmcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}
func badTool(e error) (*mcp.CallToolResult, error) {
	result := textResult(e.Error())
	result.IsError = true
	return result, nil
}
func (c *Catalog) server() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "galaxy-public-docs", Version: "0.1.0"}, nil)
	read := func(_ context.Context, r *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		uri, e := url.Parse(r.Params.URI)
		if e != nil || uri.Scheme != "galaxy-docs" || uri.User != nil || uri.RawQuery != "" || uri.Fragment != "" || uri.Host == "" || !strings.HasPrefix(uri.Path, "/") {
			return nil, errors.New("unknown public document or version")
		}
		text, e := c.document(uri.Host, strings.TrimPrefix(uri.Path, "/"))
		if e != nil {
			return nil, e
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: r.Params.URI, MIMEType: "text/markdown", Text: text}}}, nil
	}
	for _, v := range c.versions {
		for _, name := range topics {
			resourceName := name + "-" + v
			if v == "v0.1" {
				resourceName = name
			}
			s.AddResource(&mcp.Resource{Name: resourceName, URI: "galaxy-docs://" + v + "/" + name, MIMEType: "text/markdown", Title: name + " " + v}, read)
		}
	}
	for _, name := range topics {
		s.AddResource(&mcp.Resource{Name: name + "-current", URI: "galaxy-docs://current/" + name, MIMEType: "text/markdown", Title: name + " current (" + c.current + ")"}, read)
	}
	s.AddResourceTemplate(&mcp.ResourceTemplate{Name: "versioned-public-document", URITemplate: "galaxy-docs://{version}/{topic}", MIMEType: "text/markdown", Description: "Only reviewed public documents; current " + c.current + "; all catalogued historical versions remain available."}, read)
	versions := append([]string{"current"}, c.versions...)
	versionSchema := map[string]any{"type": "string", "enum": versions, "default": "current"}
	falseValue := false
	annotations := &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: &falseValue, OpenWorldHint: &falseValue}
	for _, name := range []string{"docs_get", "docs_search"} {
		properties := map[string]any{"version": versionSchema}
		required := []string{}
		description := "Read a reviewed public Galaxy document."
		if name == "docs_get" {
			properties["topic"] = map[string]any{"type": "string", "enum": topics}
			required = append(required, "topic")
		} else {
			description = "Search the four reviewed public documents in the selected version. No private data or network access."
			properties["query"] = map[string]any{"type": "string", "minLength": 1, "maxLength": 128}
			required = append(required, "query")
		}
		s.AddTool(&mcp.Tool{Name: name, Description: description, InputSchema: map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}, Annotations: annotations}, func(_ context.Context, r *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return c.call(name, r.Params.Arguments)
		})
	}
	for _, name := range []string{"installation", "privacy"} {
		s.AddPrompt(&mcp.Prompt{Name: "explain-" + name, Description: "Explain the public " + name + " document. No actions are authorized by this prompt."}, func(_ context.Context, _ *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			text, _ := c.document(c.current, name)
			return &mcp.GetPromptResult{Messages: []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: "请解释以下公开文档，并明确当前限制。仅作说明，不执行初始化、连接或发布。\n\n" + text}}}}, nil
		})
	}
	return s
}
func (c *Catalog) call(name string, raw json.RawMessage) (*mcp.CallToolResult, error) {
	var input map[string]json.RawMessage
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return badTool(errors.New("invalid public document input"))
	}
	field := "topic"
	if name == "docs_search" {
		field = "query"
	}
	for key := range input {
		if key != "version" && key != field {
			return badTool(errors.New("invalid public document input"))
		}
	}
	version := "current"
	if v, ok := input["version"]; ok {
		if string(v) == "null" || json.Unmarshal(v, &version) != nil {
			return badTool(errors.New("invalid public document version"))
		}
	}
	var value string
	if string(input[field]) == "null" || json.Unmarshal(input[field], &value) != nil {
		return badTool(errors.New("invalid public document input"))
	}
	if _, e := c.document(version, "overview"); e != nil {
		return badTool(e)
	}
	if name == "docs_get" {
		text, e := c.document(version, value)
		if e != nil {
			return badTool(e)
		}
		return textResult(text), nil
	}
	value = jsTrim(value)
	if value == "" || protocol.TextLength(value) > 128 {
		return badTool(errors.New("invalid public document query"))
	}
	if version == "current" {
		version = c.current
	}
	results := []map[string]string{}
	for _, topic := range topics {
		text, _ := c.document(version, topic)
		if strings.Contains(strings.ToLower(text), strings.ToLower(value)) {
			results = append(results, map[string]string{"topic": topic, "uri": fmt.Sprintf("galaxy-docs://%s/%s", version, topic)})
		}
	}
	encoded, e := protocol.Encode(struct {
		Version string              `json:"version"`
		Results []map[string]string `json:"results"`
	}{version, results})
	if e != nil {
		return nil, e
	}
	return textResult(string(encoded)), nil
}
func jsTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r == 0x9 || r == 0xa || r == 0xb || r == 0xc || r == 0xd || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	})
}
