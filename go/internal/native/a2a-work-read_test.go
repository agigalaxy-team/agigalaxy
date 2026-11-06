package native

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The outer purpose reader and low-level reader each check their own lease;
// their single source read must not expose an old peer response after denial.
func TestA2aWorkReadUsesOneCurrentTaskProjection(t *testing.T) {
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixture(t)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	if _, e = runtime.Restore(ctx); e != nil {
		t.Fatal(e)
	}
	_, card := a2aOriginalPeer(t)
	configuration := []byte(`{"peers":[{"id":"peer","endpoint":"https://peer.example.org/a2a","peerPrincipal":"peer-user","agentCard":` + card + `,"cardHash":"` + a2aHash([]byte(card)) + `","trustExpiresAt":` + strconv.FormatInt(now().UnixMilli()+3600000, 10) + `,"authentication":{"mode":"none"}}]}`)
	host, e := NewNativeA2a(runtime, configuration, A2aOptions{Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer host.Close()
	_, cancel, _, _, journal, e := host.adapter(ctx, "peer")
	if e != nil {
		t.Fatal(e)
	}
	cancel()
	taskID, associationID := uuid.NewString(), uuid.NewString()
	_, e = journal.change(ctx, associationID, 0, nil, func(map[string]any) (map[string]any, error) {
		return map[string]any{"id": associationID, "source": map[string]any{"kind": "task", "taskId": taskID, "version": 1}, "peer": map[string]any{"state": "completed", "taskId": "peer-task", "text": "current answer"}, "status": "observed", "operations": []any{map[string]any{"id": "old", "kind": "send", "response": map[string]any{"text": "old private response"}}, map[string]any{"id": "new", "kind": "reply", "outcome": "observed"}}}, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	count := 0
	allow := true
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v2/tasks/"+taskID {
			return response, nil
		}
		count++
		_ = response.Body.Close()
		body := fmt.Sprintf(`{"schemaVersion":2,"taskId":%q,"version":1,"request":{"title":"Actual request"}}`, taskID)
		if !allow {
			response.StatusCode = 403
			body = `{"error":"access_denied"}`
		} else {
			response.StatusCode = 200
		}
		response.Body = io.NopCloser(strings.NewReader(body))
		response.ContentLength = int64(len(body))
		return response, nil
	})
	defer transport.setHook(nil)
	_, stop, lease, e := runtime.identityLease(ctx, false)
	if e != nil {
		t.Fatal(e)
	}
	defer stop()
	work := NewNativeA2aWork(host)
	defer work.Close()
	value, e := work.Read(ctx, lease, map[string]any{"action": "get", "peerId": "peer", "associationId": associationID})
	if e != nil {
		t.Fatal(e)
	}
	if count != 1 {
		t.Fatalf("current source read %d times, want one", count)
	}
	selected := uploadObject(value["selected"])
	projected := uploadObject(selected["peer"])
	if projected["operations"] != nil || text(uploadObject(projected["peer"])["text"]) != "current answer" || uploadObject(uploadObject(selected["association"])["source"])["taskId"] != taskID {
		t.Fatal("incorrect purpose projection", selected)
	}
	full, e := host.Read(ctx, map[string]any{"action": "get", "peerId": "peer", "associationId": associationID})
	if e != nil || len(uploadRows(uploadObject(full)["operations"])) != 2 {
		t.Fatalf("original journal not readable: %v %v", full, e)
	}
	allow = false
	before := count
	withheld, e := work.Read(ctx, lease, map[string]any{"action": "get", "peerId": "peer", "associationId": associationID})
	if count-before != 1 {
		t.Fatalf("denied source read %d times, want one", count-before)
	}
	if e != nil {
		if runtimeErrorCode(e) != "device_management_native_connection_changed" || withheld != nil {
			t.Fatalf("unexpected denial outcome: %v", e)
		}
	} else {
		view := uploadObject(withheld["selected"])
		if view["sourceUnavailable"] != true || view["peer"] != nil {
			t.Fatal("denied source exposed a peer response")
		}
	}
}
