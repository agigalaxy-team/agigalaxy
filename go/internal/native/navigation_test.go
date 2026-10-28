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
	"time"
)

type navigationReadTransport struct {
	id       string
	requests int
	state    string
}

func (f *navigationReadTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	f.requests++
	if request.Header.Get("Authorization") != "" || request.URL.Path != "/v2/community/posts/"+f.id {
		panic("unexpected navigation fixture network")
	}
	raw := hostJSONString(map[string]any{"locator": map[string]any{"postId": f.id}, "availability": f.state, "body": "Only present when current permission allows"})
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(raw)), Request: request}, nil
}
func TestNavigationOriginalJournalPathsAndReturnScope(t *testing.T) {
	ctx := context.Background()
	store, e := NewStore(t.TempDir(), "https://navigation.invalid")
	if e != nil {
		t.Fatal(e)
	}
	transport := &navigationReadTransport{id: "00000000-0000-4000-8000-000000000001", state: "available"}
	runtime, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	launched := ""
	navigation := NewNativeNavigation(runtime, NavigationOptions{OpenBrowser: func(_ context.Context, url string) (map[string]any, error) {
		launched = url
		return map[string]any{"state": "launch-requested", "launched": true}, nil
	}})
	input := map[string]any{"object": map[string]any{"kind": "community", "topic": "technology", "query": "  A~* +/😀  "}, "origin": map[string]any{"host": "synthetic-host", "workRef": "private original prompt"}}
	opened, e := navigation.Open(ctx, input)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(launched, "private") || opened["opened"] != "unverified" || opened["businessMutation"] != false {
		t.Fatal(opened, launched)
	}
	script := `import {createNativeStore} from './packages/galaxy-edge-mcp/src/native-v2/store.mjs';import {createNativeNavigation} from './packages/galaxy-edge-mcp/src/native-v2/interaction/navigation.mjs';const navigation=createNativeNavigation({website:'https://website.invalid',store:createNativeStore(process.argv[1]),captureLease:async()=>({subjectId:null,endpoint:'https://navigation.invalid',assertCurrent(){}}),openBrowser:async()=>({state:'launch-requested',launched:true}),refresh:async()=>{throw Error('unexpected refresh')}});console.log(JSON.stringify(await navigation.resume(process.argv[2])));`
	original := initializationNode(t, script, store.Directory, text(opened["navigationId"]))
	resumed, e := navigation.Resume(ctx, text(opened["navigationId"]))
	if e != nil || !connectionEqual(resumed, original) {
		t.Fatal("original journal return differs", resumed, original, e)
	}
	reference := initializationNode(t, `import {createNativeStore} from './packages/galaxy-edge-mcp/src/native-v2/store.mjs';import {createNativeNavigation} from './packages/galaxy-edge-mcp/src/native-v2/interaction/navigation.mjs';const navigation=createNativeNavigation({website:'https://website.invalid',store:createNativeStore(process.argv[1]),captureLease:async()=>({subjectId:null,endpoint:'https://navigation.invalid',assertCurrent(){}}),openBrowser:async()=>({state:'launch-requested',launched:true}),refresh:async()=>{throw Error('unexpected refresh')}});console.log(JSON.stringify(await navigation.prepare({object:{kind:'community',topic:'technology',query:'  A~* +/😀  '},origin:{host:'synthetic-host',workRef:'private original prompt'}})));`, store.Directory)
	if opened["targetPath"] != reference["targetPath"] {
		t.Fatal("WHATWG route differs", opened, reference)
	}
	prepared, e := navigation.Prepare(ctx, map[string]any{"object": map[string]any{"kind": "post", "id": transport.id}})
	if e != nil {
		t.Fatal(e)
	}
	result, e := navigation.Resume(ctx, text(prepared["navigationId"]))
	if e != nil || result["current"] != true || transport.requests != 1 {
		t.Fatal(result, e)
	}
	transport.state = "withdrawn"
	result, e = navigation.Resume(ctx, text(prepared["navigationId"]))
	if e != nil || result["data"] != nil || result["sourceError"] != "forum_content_withdrawn" {
		t.Fatal("withdrawn original body returned", result, e)
	}
	if _, e = os.Stat(filepath.Join(store.Directory, "galaxy-id.json")); !os.IsNotExist(e) {
		t.Fatal("navigation created identity")
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.InitializeLocalIdentity(ctx, "person", true, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = navigation.Resume(ctx, text(prepared["navigationId"])); e == nil {
		t.Fatal("previous owner record adopted")
	}
}
func TestNavigationScopeChangeDuringLaunchAndTimeout(t *testing.T) {
	ctx := context.Background()
	store, e := NewStore(t.TempDir(), "https://navigation.invalid")
	if e != nil {
		t.Fatal(e)
	}
	runtime := commandRuntime(t, store)
	navigation := NewNativeNavigation(runtime, NavigationOptions{OpenBrowser: func(ctx context.Context, _ string) (map[string]any, error) {
		scope, e := store.ChoiceScope(ctx)
		if e != nil {
			return nil, e
		}
		_, e = store.InitializeLocalIdentity(ctx, "person", true, &scope)
		return map[string]any{"state": "launch-requested", "launched": true}, e
	}})
	if _, e = navigation.Open(ctx, map[string]any{"object": map[string]any{"kind": "messages"}}); e == nil {
		t.Fatal("launch owner changed unnoticed")
	}
	navigation = NewNativeNavigation(runtime, NavigationOptions{Timeout: time.Millisecond, OpenBrowser: func(ctx context.Context, _ string) (map[string]any, error) { <-ctx.Done(); return nil, ctx.Err() }})
	value, e := navigation.Open(ctx, map[string]any{"object": map[string]any{"kind": "messages"}})
	if e != nil || value["state"] != "launch-timeout" || value["opened"] != "unverified" {
		t.Fatal(value, e)
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "navigation", Version: "1"}, nil)
	registerNavigationTools(server, &toolRuntime{store: store}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "navigation", Version: "1"}, nil)
	session, e := client.Connect(ctx, ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	materialCall(t, session, "galaxy_open", map[string]any{"object": map[string]any{"kind": "messages", "url": "https://injected.invalid"}}, true)
	materialCall(t, session, "galaxy_return", map[string]any{"navigationId": nil}, true)
	var record map[string]any
	raw, _ := protocol.Encode(value)
	if protocol.Decode(raw, &record) != nil {
		t.Fatal("navigation result invalid")
	}
}
