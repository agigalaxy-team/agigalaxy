package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func handoffMCPClient(t *testing.T, runtime *Runtime, choices *atomic.Int32) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	server := mcp.NewServer(&mcp.Implementation{Name: "handoff-test", Version: "1"}, nil)
	registerNativeHandoffTools(server, &toolRuntime{store: runtime.store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "handoff-test", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		choices.Add(1)
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
	}})
	cs, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cs.Close(); ss.Close() })
	return cs
}
func TestNativeHandoffBlankDeviceOriginalProofAndSelectionFence(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	controllerStore, meta, transport := nativeGoUploadFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	authority := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now, AllowedScopes: connectionBrowserScopes}
	original, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(original)
	control := deviceauth.Handler{Service: authority, Next: fallback}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v2/identity/") {
			control.ServeHTTP(w, r)
		} else {
			fallback.ServeHTTP(w, r)
		}
	}))
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	controller, e := NewRuntime(controllerStore, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer controller.Close()
	controllerScope, e := controllerStore.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	joiningStore, e := NewStore(t.TempDir(), meta.Configuration.Endpoint)
	if e != nil {
		t.Fatal(e)
	}
	config := meta.Configuration
	config.DataDirectory = joiningStore.Directory
	joining, e := NewRuntime(joiningStore, config, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer joining.Close()
	blank, e := joiningStore.ChoiceScope(ctx)
	if e != nil || blank.Owner != "" || blank.DeviceID != "" {
		t.Fatal("fixture joining device is not blank")
	}
	var choices atomic.Int32
	joiningClient := handoffMCPClient(t, joining, &choices)
	controllerClient := handoffMCPClient(t, controller, &choices)
	offer := materialCall(t, joiningClient, "galaxy_device_offer", map[string]any{"subjectId": controllerScope.Owner}, false)
	if offer["subjectId"] != controllerScope.Owner || choices.Load() != 1 {
		t.Fatal("blank offer skipped actual person choice")
	}
	keyPath := filepath.Join(joiningStore.Directory, "native-v2", "keys", text(offer["deviceId"])+".pem")
	private, e := os.ReadFile(keyPath)
	if e != nil {
		t.Fatal(e)
	}
	keyDigest := identity.Digest(private)
	if owner, e := joiningStore.Owner(ctx); e != nil || owner != "" {
		t.Fatal("offer invented or selected an identity")
	}
	rawOffer, _ := protocol.Encode(offer)
	approval := materialCall(t, controllerClient, "galaxy_device_approve", map[string]any{"offer": string(rawOffer)}, false)
	if approval["type"] != "galaxy-device-approval" || choices.Load() != 2 {
		t.Fatal("controller did not approve original public packet")
	}
	rawApproval, _ := protocol.Encode(approval)
	h := NewNativeDeviceHandoff(joining)
	// A real intervening local selection must survive this old blank review.
	selected, e := controller.connection.selection(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = joiningStore.With(ctx, true, func(dir string) error {
		return uploadNativeRecordWithin(dir, "native-selection:"+config.Endpoint, map[string]any{"version": 1, "revision": 1, "active": selected.Active, "permission": map[string]any{"enabled": false}})
	}); e != nil {
		t.Fatal(e)
	}
	if _, e = h.AcceptReviewed(ctx, string(rawApproval), &blank); fault.Code(e) != "device_handoff_owner_changed" {
		t.Fatalf("stale blank choice accepted: %v", e)
	}
	changed, e := joiningStore.ChoiceScope(ctx)
	if e != nil || changed.Owner != controllerScope.Owner || changed.DeviceID != controllerScope.DeviceID || changed.Revision != 1 {
		t.Fatal("old blank request overwrote new owner")
	}
	if e = joiningStore.With(ctx, true, func(dir string) error {
		return uploadNativeRecordWithin(dir, "native-selection:"+config.Endpoint, map[string]any{"version": 1, "revision": 2, "active": nil, "permission": nil})
	}); e != nil {
		t.Fatal(e)
	}
	var commits atomic.Int32
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/identity/control/commit" && response.StatusCode >= 200 && response.StatusCode < 300 {
			commits.Add(1)
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	unknown := materialCall(t, joiningClient, "galaxy_device_accept", map[string]any{"approval": string(rawApproval)}, true)
	if unknown["error"] != "native_request_transport_failed" || commits.Load() != 1 || choices.Load() != 3 {
		t.Fatalf("unknown handoff dispatch: %v commits=%d", unknown["error"], commits.Load())
	}
	if owner, e := joiningStore.Owner(ctx); e != nil || owner != "" {
		t.Fatal("unknown remote ACK claimed local activation")
	}
	joiningClient.Close()
	joining.Close()
	joining, e = NewRuntime(joiningStore, config, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer joining.Close()
	h = NewNativeDeviceHandoff(joining)
	result, e := h.Reconcile(ctx, text(offer["operationId"]))
	if e != nil || uploadObject(result)["activated"] != true || uploadObject(result)["connectionRequired"] != true || commits.Load() != 1 {
		t.Fatalf("original handoff did not reconcile/activate: %v", e)
	}
	transport.setHook(nil)
	adopted, e := joiningStore.ChoiceScope(ctx)
	if e != nil || adopted.Owner != controllerScope.Owner || adopted.DeviceID != offer["deviceId"] || adopted.Revision != 3 {
		t.Fatalf("adopted original choice: %v", e)
	}
	connection, e := joining.connection.selection(ctx)
	if e != nil || connection.Permission == nil || connection.Permission.Enabled {
		t.Fatal("accept silently enabled a connection")
	}
	private, e = os.ReadFile(keyPath)
	if e != nil || identity.Digest(private) != keyDigest {
		t.Fatal("handoff recovery replaced existing device material")
	}
	if present, e := exists(filepath.Join(joiningStore.Directory, "galaxy-id.json")); e != nil || present {
		t.Fatal("handoff created a replacement GUID")
	}
	before := transport.count()
	status, e := joining.Status(ctx, RuntimeStatusOptions{RestoreSelected: true})
	if e != nil || uploadObject(status)["connected"] != false || transport.count() != before {
		t.Fatalf("accept implicitly connected: %v", e)
	}
	result, e = h.Reconcile(ctx, text(offer["operationId"]))
	if e != nil || uploadObject(result)["activated"] != false || uploadObject(result)["alreadyActivated"] != true {
		t.Fatalf("committed history reactivated selection: %v", e)
	}
	result, e = h.Cancel(ctx, text(offer["operationId"]))
	if e != nil || uploadObject(uploadObject(result)["receipt"])["state"] != "committed" || uploadObject(result)["activated"] != false {
		t.Fatalf("committed operation was canceled: %v", e)
	}
	pending, e := h.Pending(ctx)
	if e != nil || uploadObject(pending)["state"] != "committed" || uploadObject(pending)["hasOriginalCommit"] != true {
		t.Fatal("committed handoff journal unavailable", pending, e)
	}
	result, e = h.Reconcile(ctx, text(offer["operationId"]))
	if e != nil || uploadObject(result)["activated"] != false || uploadObject(result)["alreadyActivated"] != true {
		t.Fatal("handoff replay activated again", result, e)
	}

}
