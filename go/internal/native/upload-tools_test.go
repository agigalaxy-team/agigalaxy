package native

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"testing"
)

func TestUploadToolsStrictSchemasAndReviewedPrivacy(t *testing.T) {
	ctx := context.Background()
	store := materialStore(t)
	runtime, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	server := mcp.NewServer(&mcp.Implementation{Name: "upload-test", Version: "1"}, nil)
	tools := &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}
	registerUploadTools(server, tools, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "upload-test", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
	}})
	cs, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	listed, e := cs.ListTools(ctx, nil)
	if e != nil || len(listed.Tools) != 18 {
		t.Fatalf("registered tools: %v %v", e, listed)
	}
	materialCall(t, cs, "galaxy_local_upload_privacy_set", map[string]any{"galaxyId": "material-owner", "level": "local-only"}, false)
	materialCall(t, cs, "galaxy_local_upload_privacy_set", map[string]any{"level": "work-content", "unknown": true}, true)
	materialCall(t, cs, "galaxy_work_sync_choice", map[string]any{"choiceId": "00000000-0000-4000-8000-000000000001", "workIds": []string{}}, true)
	materialCall(t, cs, "galaxy_local_settings_save", map[string]any{"choiceId": "00000000-0000-4000-8000-000000000001", "level": "history-overview", "conversationMode": "off", "sessions": []any{}}, true)
	materialCall(t, cs, "galaxy_archive_sync_flush", map[string]any{"archiveSessionId": nil}, true)
	result := materialCall(t, cs, "galaxy_local_upload_privacy_get", map[string]any{}, false)
	if uploadObject(result["settings"])["level"] != "local-only" {
		t.Fatalf("reviewed privacy not saved: %v", result)
	}
}
