package native

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestPrivateSyncStopsForDisabledAndClosedLifecycle(t *testing.T) {
	store := materialStore(t)
	rt, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	if retry, active := rt.privateSync.run(context.Background()); retry || active {
		t.Fatal("disabled saved permission scheduled recovery")
	}
	rt.mu.Lock()
	rt.stopped = true
	rt.mu.Unlock()
	if retry, active := rt.privateSync.run(context.Background()); retry || active {
		t.Fatal("stopped connection scheduled recovery")
	}
	rt.Close()
	if retry, active := rt.privateSync.run(context.Background()); retry || active {
		t.Fatal("closed runtime scheduled recovery")
	}
}

// This gate blocks a real archive create before the fixture service receives it.
// Other requests still reach the same existing Go HTTP fixture normally.
type lifecycleArchiveGate struct {
	next                        http.RoundTripper
	entered, release, duplicate chan struct{}
	creates, chunks             atomic.Int32
}

func (g *lifecycleArchiveGate) RoundTrip(req *http.Request) (*http.Response, error) {
	switch req.URL.Path {
	case "/v2/account-archives/create":
		if g.creates.Add(1) == 1 {
			close(g.entered)
			select {
			case <-g.release:
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
		} else {
			select {
			case g.duplicate <- struct{}{}:
			default:
			}
		}
	case "/v2/account-archives/chunk":
		g.chunks.Add(1)
	}
	return g.next.RoundTrip(req)
}

func TestPrivateSessionAndMCPArchiveFlushShareWriter(t *testing.T) {
	store, meta, transport := nativeGoUploadFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	gate := &lifecycleArchiveGate{next: transport, entered: make(chan struct{}), release: make(chan struct{}), duplicate: make(chan struct{}, 1)}
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: gate}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	var unblock sync.Once
	defer unblock.Do(func() { close(gate.release) })
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	enabled := true
	sessions := []ArchiveSession{{Host: "opencode", SessionID: "opaque-session"}}
	if _, e = store.configureArchive(ctx, ArchiveInput{GalaxyID: scope.Owner, Enabled: &enabled, Sessions: sessions}, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = store.CaptureArchiveMessage(ctx, ArchiveCaptureInput{GalaxyID: scope.Owner, Host: "opencode", SessionID: "opaque-session", MessageID: "synthetic-original", Message: json.RawMessage(`{"role":"user"}`), Parts: json.RawMessage(`[{"type":"text","text":"isolated original"}]`)}); e != nil {
		t.Fatal(e)
	}
	input := NativeLocalSettingsInput{ChoiceID: uuid.NewString(), GalaxyID: &scope.Owner, Level: "conversation-archive", ConversationMode: "cloud", Sessions: sessions, TargetAccountID: &meta.TargetID, RestoreArchiveSessionIDs: []string{}}
	if _, e = rt.SaveLocalSettingsReviewed(ctx, input, &scope); e != nil {
		t.Fatal(e)
	}
	archive := NewArchiveUpload(rt)
	settings, e := archive.Settings(ctx)
	if e != nil {
		t.Fatal(e)
	}
	ids, _ := connectionStrings(uploadObject(uploadObject(settings)["choice"])["archiveSessionIds"])
	if len(ids) != 1 {
		t.Fatalf("archive selection: %v", settings)
	}
	prepared, e := archive.Prepare(ctx, ids[0], 0)
	if e != nil {
		t.Fatal(e)
	}
	job := uploadObject(uploadObject(prepared)["job"])
	id := text(job["id"])
	expectedChunks := int32(integer(job["chunkCount"]))
	if id == "" || expectedChunks < 1 {
		t.Fatalf("archive job: %v", prepared)
	}

	server := mcp.NewServer(&mcp.Implementation{Name: "upload-concurrent-test", Version: "1"}, nil)
	registerUploadTools(server, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, rt)
	toolEntered := make(chan struct{}, 2)
	toolFinished := make(chan struct{}, 2)
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if method == "tools/call" {
				toolEntered <- struct{}{}
				defer func() { toolFinished <- struct{}{} }()
			}
			return next(ctx, method, req)
		}
	})
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, serverTransport, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "upload-concurrent-client", Version: "1"}, nil)
	cs, e := client.Connect(ctx, clientTransport, &mcp.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	// Release the blocked HTTP request before session teardown on a failed assertion.
	defer unblock.Do(func() { close(gate.release) })

	type outcome struct {
		value any
		err   error
	}
	firstDone := make(chan outcome, 1)
	go func() {
		value, err := rt.PrivateSessionComplete(ctx, "opencode", "opaque-session")
		firstDone <- outcome{value, err}
	}()
	select {
	case <-gate.entered:
	case result := <-firstDone:
		t.Fatalf("session pass ended before archive create: %v %v", result.value, result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	callCtx, cancelCall := context.WithCancel(ctx)
	defer cancelCall()
	callDone := make(chan outcome, 1)
	go func() {
		value, err := cs.CallTool(callCtx, &mcp.CallToolParams{Name: "galaxy_archive_sync_flush", Arguments: map[string]any{"archiveSessionId": ids[0]}})
		callDone <- outcome{value, err}
	}()
	select {
	case <-toolEntered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case <-gate.duplicate:
		t.Fatal("MCP flush issued a second create while session pass was active")
	case <-toolFinished:
		t.Fatal("MCP flush finished while the original create was blocked")
	case <-time.After(400 * time.Millisecond):
	}
	cancelCall()
	select {
	case call := <-callDone:
		if call.err == nil {
			result, ok := call.value.(*mcp.CallToolResult)
			if !ok || result == nil || !result.IsError {
				t.Fatalf("cancelled MCP flush unexpectedly succeeded: %v", call.value)
			}
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case <-toolFinished:
	case <-ctx.Done():
		t.Fatal("cancelled server handler did not stop")
	}
	if gate.creates.Load() != 1 || gate.chunks.Load() != 0 {
		t.Fatalf("cancelled waiter sent archive writes: creates=%d chunks=%d", gate.creates.Load(), gate.chunks.Load())
	}
	unblock.Do(func() { close(gate.release) })
	select {
	case first := <-firstDone:
		if first.err != nil || uploadObject(first.value)["state"] != "processed" {
			t.Fatalf("session pass: %v %v", first.value, first.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	status, e := rt.Call(ctx, "/v2/account-archives/status", map[string]any{"id": id}, ConnectionCallOptions{AccountID: meta.TargetID})
	if e != nil || status["id"] != id || status["state"] != "ready" {
		t.Fatalf("original archive receipt: %v %v", status, e)
	}
	result, e := cs.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_archive_sync_flush", Arguments: map[string]any{"archiveSessionId": ids[0]}})
	if e != nil || result == nil || result.IsError {
		t.Fatalf("subsequent MCP flush: %v %v", result, e)
	}
	if gate.creates.Load() != 1 || gate.chunks.Load() != expectedChunks {
		t.Fatalf("original archive replayed: creates=%d chunks=%d expected=%d", gate.creates.Load(), gate.chunks.Load(), expectedChunks)
	}
}
