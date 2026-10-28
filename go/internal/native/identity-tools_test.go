package native

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestNativeDeviceToolSchemasRejectModelConfirmation(t *testing.T) {
	ctx := context.Background()
	store := materialStore(t)
	runtime, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	server := mcp.NewServer(&mcp.Implementation{Name: "identity-test", Version: "1"}, nil)
	registerIdentityControlTools(server, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "identity-test", Version: "1"}, nil)
	cs, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	tools, e := cs.ListTools(ctx, nil)
	if e != nil || len(tools.Tools) != 14 {
		t.Fatalf("identity tools: %v", e)
	}
	materialCall(t, cs, "galaxy_identity_device_native_confirm", map[string]any{"previewId": "00000000-0000-4000-8000-000000000001", "confirmed": true}, true)
	materialCall(t, cs, "galaxy_identity_device_native_read", map[string]any{"action": "current", "operationId": "00000000-0000-4000-8000-000000000001"}, true)
	materialCall(t, cs, "galaxy_identity_device_native_read", map[string]any{"action": "reconcile"}, true)
	materialCall(t, cs, "galaxy_identity_device_native_prepare_revoke", map[string]any{}, true)
	materialCall(t, cs, "galaxy_identity_account_execute", map[string]any{"previewId": "00000000-0000-4000-8000-000000000001", "confirmed": true}, true)
	materialCall(t, cs, "galaxy_identity_account_read", map[string]any{"action": "providers", "id": "00000000-0000-4000-8000-000000000001"}, true)
	materialCall(t, cs, "galaxy_identity_account_read", map[string]any{"action": "begin", "providerId": "InventedProvider"}, true)
	materialCall(t, cs, "galaxy_identity_account_recover", map[string]any{"id": nil}, true)
	materialCall(t, cs, "galaxy_device_offer", map[string]any{"subjectId": "GUID1000000000000000000000000000", "confirmed": true}, true)
	materialCall(t, cs, "galaxy_device_approve", map[string]any{"offer": "-----BEGIN PRIVATE KEY-----"}, true)
	materialCall(t, cs, "galaxy_device_accept", map[string]any{"approval": "{}", "confirmed": true}, true)
}

type identityNoNetwork struct{ calls atomic.Int32 }

func (n *identityNoNetwork) RoundTrip(*http.Request) (*http.Response, error) {
	n.calls.Add(1)
	return nil, connectionFailure("unexpected_fixture_network")
}
func TestNativeBlankHandoff2026DeclineKeepsNoMaterial(t *testing.T) {
	ctx := context.Background()
	store, e := NewStore(t.TempDir(), "https://handoff.invalid")
	if e != nil {
		t.Fatal(e)
	}
	network := &identityNoNetwork{}
	runtime, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{HTTPClient: &http.Client{Transport: network}})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	server := mcp.NewServer(&mcp.Implementation{Name: "blank-handoff-test", Version: "1"}, nil)
	registerNativeHandoffTools(server, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	var choices atomic.Int32
	client := mcp.NewClient(&mcp.Implementation{Name: "blank-handoff-test", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		choices.Add(1)
		return &mcp.ElicitResult{Action: "decline"}, nil
	}})
	cs, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	result := materialCall(t, cs, "galaxy_device_offer", map[string]any{"subjectId": "GUID1000000000000000000000000000"}, false)
	if result["state"] != "declined" || choices.Load() != 1 || network.calls.Load() != 0 {
		t.Fatalf("blank review performed undisclosed action: %v", result)
	}
	owner, e := store.Owner(ctx)
	if e != nil || owner != "" {
		t.Fatal("declined handoff invented owner")
	}
}
