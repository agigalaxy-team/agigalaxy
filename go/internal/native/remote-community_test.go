package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type remotePublicTransport struct {
	requests []*http.Request
	bodies   []map[string]any
}

func (f *remotePublicTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	f.requests = append(f.requests, request.Clone(request.Context()))
	var body map[string]any
	if request.Body != nil {
		raw, _ := io.ReadAll(request.Body)
		_ = protocol.Decode(raw, &body)
	}
	f.bodies = append(f.bodies, body)
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"items":[],"nextAfter":null}`)), Request: request}, nil
}
func TestRemoteCommunityAnonymousFixedRoutesAndOriginalSchemas(t *testing.T) {
	ctx := context.Background()
	id := "00000000-0000-4000-8000-000000000001"
	subject := "GUID1000000000000000000000000000"
	cases := []map[string]any{{"name": "galaxy_community_query", "input": map[string]any{"accountId": id, "query": strings.Repeat(" ", 200) + "银河"}}, {"name": "galaxy_community_read", "input": map[string]any{"postId": id}}, {"name": "galaxy_community_read", "input": map[string]any{"postId": id, "versionId": id, "accountId": id}}, {"name": "galaxy_community_replies", "input": map[string]any{"postId": id, "postVersionId": id}}, {"name": "galaxy_community_versions", "input": map[string]any{"postId": id}}, {"name": "galaxy_account_public_profile", "input": map[string]any{"accountId": id}}, {"name": "galaxy_account_public_ids", "input": map[string]any{"accountId": id, "after": subject, "limit": 50}}, {"name": "galaxy_account_public_credentials", "input": map[string]any{"accountId": id}}, {"name": "galaxy_account_public_posts", "input": map[string]any{"accountId": id}}, {"name": "galaxy_account_public_by_id", "input": map[string]any{"subjectId": subject}}}
	fixture := filepath.Join(t.TempDir(), "cases.json")
	if e := writeJSON(fixture, cases); e != nil {
		t.Fatal(e)
	}
	original := initializationNode(t, `import {readFile} from 'node:fs/promises';import {nativeHttpDefinitions} from './packages/galaxy-edge-mcp/src/native-v2/tools/http.mjs';const calls=[],api={call:(path,input,options)=>{calls.push({path,input:input??null,options:options??null});return {items:[]}}},tools=nativeHttpDefinitions(api),cases=JSON.parse(await readFile(process.argv[1],'utf8')),normalized=[];for(const c of cases){const parsed=tools[c.name].inputSchema.parse(c.input);normalized.push(parsed);await tools[c.name].run(parsed)}console.log(JSON.stringify({calls,normalized}));`, fixture)
	store, e := NewStore(filepath.Join(t.TempDir(), "blank"), "https://community.invalid")
	if e != nil {
		t.Fatal(e)
	}
	transport := &remotePublicTransport{}
	runtime, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	client := NewNativeCommunity(runtime)
	for i, item := range cases {
		normalized, e := remoteCommunityNormalize(text(item["name"]), item["input"])
		if e != nil || !connectionEqual(normalized, uploadRows(original["normalized"])[i]) {
			t.Fatal("source normalization differs", i, normalized, e)
		}
		if _, e = client.Call(ctx, text(item["name"]), item["input"]); e != nil {
			t.Fatal(i, e)
		}
		expected := uploadObject(uploadRows(original["calls"])[i])
		request := transport.requests[i]
		if request.URL.RequestURI() != expected["path"] {
			t.Fatal("source path differs", i, request.URL.RequestURI(), expected)
		}
		method := "POST"
		if uploadObject(expected["options"])["method"] == "GET" {
			method = "GET"
		}
		if request.Method != method || request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" || request.Header.Get("X-Galaxy-Account-Id") != "" || !connectionEqual(transport.bodies[i], expected["input"]) {
			t.Fatal("anonymous source transport differs", i, transport.bodies[i], expected)
		}
	}
	before := len(transport.requests)
	if _, e = client.Call(ctx, "galaxy_community_topics", map[string]any{}); e != nil || len(transport.requests) != before {
		t.Fatal("static topics networked", e)
	}
	if _, e = os.Stat(store.Directory); !os.IsNotExist(e) {
		t.Fatal("anonymous read created identity or material")
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "community", Version: "1"}, nil)
	registerRemoteCommunityTools(server, &toolRuntime{store: store}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	mcpClient := mcp.NewClient(&mcp.Implementation{Name: "community", Version: "1"}, nil)
	session, e := mcpClient.Connect(ctx, ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	tools, e := session.ListTools(ctx, nil)
	if e != nil || len(tools.Tools) != 12 {
		t.Fatal("incomplete public/community tools", e)
	}
	materialCall(t, session, "galaxy_account_public_ids", map[string]any{"accountId": id, "limit": 51}, true)
	materialCall(t, session, "galaxy_community_read", map[string]any{"postId": id, "endpoint": "https://invented.invalid"}, true)
}
