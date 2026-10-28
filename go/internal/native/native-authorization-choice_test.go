package native

import (
	"context"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeAuthorizationFirstChoiceDeclineAndNoImplicitRestore(t *testing.T) {
	ctx := context.Background()
	store := materialStore(t)
	network := &identityNoNetwork{}
	runtime, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{HTTPClient: &http.Client{Transport: network}})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	input := map[string]any{"requestId": uuid.NewString(), "action": "profile.publish", "objectId": "own-profile", "payloadJson": "{\"displayName\":\"synthetic\"}"}
	if _, e = runtime.AuthorizeReviewed(ctx, input, nil); e == nil || network.calls.Load() != 0 {
		t.Fatal("unreviewed request restored connection", e)
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "authorize", Version: "1"}, nil)
	registerNativeAuthorizationTool(server, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	choices := 0
	client := mcp.NewClient(&mcp.Implementation{Name: "authorize", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		choices++
		return &mcp.ElicitResult{Action: "decline"}, nil
	}})
	session, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	result := materialCall(t, session, "galaxy_native_authorize", input, false)
	if result["state"] != "declined" || choices != 1 || network.calls.Load() != 0 {
		t.Fatal(result, choices, network.calls.Load())
	}
	if _, e = os.Stat(connectionRecordPath(store.Directory, "native-authorization:"+store.Endpoint+":"+text(input["requestId"]))); !os.IsNotExist(e) {
		t.Fatal("declined authorization signed or persisted")
	}
	if _, e = os.Stat(filepath.Join(store.Directory, "native-v2")); !os.IsNotExist(e) {
		t.Fatal("declined authorization created Native material")
	}
}
