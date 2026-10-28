package docsmcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestOriginalBundleAndRealSDKConsumers(t *testing.T) {
	root, _ := filepath.Abs("../../..")
	catalog, e := Load(filepath.Join(root, "packages/galaxy-official/public-docs.json"))
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var handler http.Handler
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	defer server.Close()
	handler, e = NewHandler(server.URL, catalog, nil)
	if e != nil {
		t.Fatal(e)
	}
	docsHandler := handler
	handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		done, e := httpboundary.ApplyBrowserPolicy(r, w, nil)
		if e != nil {
			w.WriteHeader(fault.Status(e))
			return
		}
		if !done {
			docsHandler.ServeHTTP(w, r)
		}
	})
	client := mcp.NewClient(&mcp.Implementation{Name: "go-docs-reader", Version: "0.1.0"}, nil)
	session, e := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp/docs"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	listed, e := session.ListResources(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(listed.Resources) != (len(catalog.versions)+1)*4 {
		t.Fatal("public resources missing")
	}
	for _, resource := range listed.Resources {
		read, e := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: resource.URI})
		if e != nil || len(read.Contents) != 1 || read.Contents[0].Text == "" {
			t.Fatal("Go SDK resource read", e)
		}
	}
	tools, e := session.ListTools(ctx, nil)
	if e != nil || len(tools.Tools) != 2 {
		t.Fatal("Go SDK tools list", e)
	}
	result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: "docs_get", Arguments: map[string]any{"topic": "privacy"}})
	if e != nil || result.IsError || result.Content[0].(*mcp.TextContent).Text != catalog.documents[catalog.current]["privacy"] {
		t.Fatal("Go SDK tool read", e)
	}
	prompt, e := session.GetPrompt(ctx, &mcp.GetPromptParams{Name: "explain-installation"})
	if e != nil || len(prompt.Messages) != 1 {
		t.Fatal("Go SDK prompt", e)
	}
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/docs-mcp-interop.mjs"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DOCS_ORIGIN="+server.URL)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("original JS SDK: %v %s", e, out)
	}
	for _, test := range []struct {
		name, method, host, origin, protocol, body string
		status                                     int
	}{
		{name: "GET", method: "GET", status: 405},
		{name: "foreign Host", method: "POST", host: "foreign.example.org", body: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, status: 403},
		{name: "foreign Origin", method: "POST", origin: "https://foreign.example.org", body: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, status: 403},
		{name: "unsupported protocol", method: "POST", protocol: "1900-01-01", body: `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, status: 400},
		{name: "oversized body", method: "POST", body: strings.Repeat("x", 32769), status: 413},
	} {
		r, _ := http.NewRequestWithContext(ctx, test.method, server.URL+"/mcp/docs", strings.NewReader(test.body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		if test.host != "" {
			r.Host = test.host
		}
		if test.origin != "" {
			r.Header.Set("Origin", test.origin)
		}
		if test.protocol != "" {
			r.Header.Set("MCP-Protocol-Version", test.protocol)
		}
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode != test.status {
			t.Errorf("%s status=%d want=%d", test.name, response.StatusCode, test.status)
		}
	}
	// Tampering is rejected before any MCP consumer is constructed.
	raw, _ := os.ReadFile(filepath.Join(root, "packages/galaxy-official/public-docs.json"))
	var bundle map[string]any
	_ = json.Unmarshal(raw, &bundle)
	bundle["versions"].(map[string]any)[catalog.current].(map[string]any)["privacy"] = "altered"
	raw, _ = json.Marshal(bundle)
	if _, e := Parse(raw); e == nil {
		t.Fatal("tampered public content accepted")
	}
}
