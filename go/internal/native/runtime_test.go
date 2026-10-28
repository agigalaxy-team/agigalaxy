package native

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func originalRuntimeStatus(t *testing.T, s *Store, website string) map[string]any {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(file), "../../..")))
	script := `import {createNativeRuntime} from 'file:///` + root + `/packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';const runtime=await createNativeRuntime({dataDirectory:process.argv[1],endpoint:process.argv[2],website:process.argv[3],trustedKeys:new Map([['fixture',{publicKeyPem:'unused in read-only status',notBefore:0,notAfter:9007199254740991,revoked:false}]]),fetch:()=>{throw Error('status performed unexpected network')},autoResumePrivateSync:false});console.log(JSON.stringify(await runtime.status()));await runtime.close();`
	cmd := exec.Command("node", "--input-type=module", "-e", script, s.Directory, s.Endpoint, website)
	raw, e := cmd.Output()
	if e != nil {
		if failure, ok := e.(*exec.ExitError); ok {
			t.Fatalf("original runtime: %v %s", e, failure.Stderr)
		}
		t.Fatal(e)
	}
	var out map[string]any
	if e = json.Unmarshal(raw, &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func TestRuntimeReadOnlyStatusMatchesOriginalWithoutCreatingData(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "absent")
	store, e := NewStore(dir, "https://status.invalid")
	if e != nil {
		t.Fatal(e)
	}
	config := Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: dir, TrustedKeys: map[string]Pin{"fixture": {}}}
	rt, e := NewRuntime(store, config, ConnectionOptions{HTTPClient: &http.Client{Transport: runtimeNoNetwork{t}}})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	status, e := rt.Status(ctx, RuntimeStatusOptions{RestoreSelected: true})
	if e != nil {
		t.Fatal(e)
	}
	same(t, originalRuntimeStatus(t, store, config.Website), status)
	if present, _ := exists(dir); present {
		t.Fatal("empty status created a data directory")
	}
	if _, e = rt.Restore(ctx); fault.Code(e) != "native_connection_choice_required" {
		t.Fatalf("missing saved permission was not distinct: %v", e)
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "galaxy-id.json"), []byte(`{"id":"local-owner","subjectType":"person","clientKind":"integration"}`), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "galaxy-local-state.json"), []byte(`{"integration":{"modules":[]}}`), 0600); e != nil {
		t.Fatal(e)
	}
	status, e = rt.Status(ctx, RuntimeStatusOptions{})
	if e != nil {
		t.Fatal(e)
	}
	same(t, originalRuntimeStatus(t, store, config.Website), status)
	legacyActive := map[string]any{"subjectId": "adopted-owner", "deviceId": "isolated-device", "installationId": "isolated-installation", "genesisProof": map[string]any{}, "bootstrapOperationId": "retained-extra-field"}
	if e = os.MkdirAll(filepath.Join(dir, "native-v2", "records"), 0700); e != nil {
		t.Fatal(e)
	}
	legacyPath := connectionRecordPath(dir, "native-active:"+store.Endpoint)
	if e = writeJSON(legacyPath, legacyActive); e != nil {
		t.Fatal(e)
	}
	before, e := os.ReadFile(legacyPath)
	if e != nil {
		t.Fatal(e)
	}
	if e = writeJSON(connectionRecordPath(dir, "native-modules:"+store.Endpoint+":adopted-owner"), map[string]any{"plan": true}); e != nil {
		t.Fatal(e)
	}
	status, e = rt.Status(ctx, RuntimeStatusOptions{})
	if e != nil {
		t.Fatal(e)
	}
	same(t, originalRuntimeStatus(t, store, config.Website), status)
	result, e := rt.Disconnect(ctx)
	if e != nil || result["remoteBindingRevoked"] != false {
		t.Fatalf("local disconnect: %v", e)
	}
	after, e := os.ReadFile(legacyPath)
	if e != nil || string(before) != string(after) {
		t.Fatal("legacy active material changed")
	}
	var record map[string]any
	if _, e = readJSON(connectionRecordPath(dir, "native-selection:"+store.Endpoint), &record); e != nil {
		t.Fatal(e)
	}
	same(t, legacyActive, record["active"])
	if integer(record["revision"]) != 1 {
		t.Fatal("legacy selection was not migrated with original revision")
	}
	status, e = rt.Status(ctx, RuntimeStatusOptions{RestoreSelected: true})
	if e != nil {
		t.Fatal(e)
	}
	same(t, originalRuntimeStatus(t, store, config.Website), status)
}

type runtimeNoNetwork struct{ t *testing.T }

func (n runtimeNoNetwork) RoundTrip(*http.Request) (*http.Response, error) {
	n.t.Error("read-only status sent a request")
	return nil, context.Canceled
}

func TestRuntimeReviewedConnectionSaveDisconnectAndConcurrentWithdrawal(t *testing.T) {
	store, meta, transport := connectionServiceFixture(t)
	ctx := context.Background()
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	status, e := rt.Status(ctx, RuntimeStatusOptions{RestoreSelected: true})
	if e != nil || status["connected"] != true {
		t.Fatalf("saved restoration: %v %v", e, status)
	}
	if _, e = rt.Disconnect(ctx); e != nil {
		t.Fatal(e)
	}
	start := transport.count()
	if _, e = rt.Call(ctx, "/v2/identity/test/control", nil, ConnectionCallOptions{Method: "GET"}); fault.Code(e) != "native_connection_choice_required" || transport.count() != start {
		t.Fatalf("stopped runtime reconnected: %v", e)
	}
	receipt, e := rt.QueryReceipt(ctx, meta.Operation)
	if e != nil || receipt["state"] != "acknowledged" {
		t.Fatalf("disconnect blocked original receipt: %v", e)
	}
	start = transport.count()
	cachePath := connectionRecordPath(store.Directory, "native-trust-identity:"+store.Endpoint+":"+status["identity"].(string))
	if e = os.Remove(cachePath); e != nil {
		t.Fatal(e)
	}
	plan, e := rt.PrepareConnect(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if transport.count() != start {
		t.Fatal("connect preview performed a handshake")
	}
	if plan.ControlEpoch != nil || plan.ControlVerification != "checked-during-connect" {
		t.Fatal("missing cache was claimed as verified current control")
	}
	if present, _ := exists(cachePath); present {
		t.Fatal("preview created a control cache")
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = rt.ConnectReviewed(ctx, plan, nil); fault.Code(e) != "native_connection_choice_required" {
		t.Fatalf("connect bypassed person choice: %v", e)
	}
	selectionPath := connectionRecordPath(store.Directory, "native-selection:"+store.Endpoint)
	if e = store.With(ctx, true, func(string) error {
		var record map[string]any
		if _, e := readJSON(selectionPath, &record); e != nil {
			return e
		}
		record["revision"] = integer(record["revision"]) + 1
		return writeJSON(selectionPath, record)
	}); e != nil {
		t.Fatal(e)
	}
	start = transport.count()
	if _, e = rt.ConnectReviewed(ctx, plan, &scope); fault.Code(e) != "native_connection_selection_changed" || transport.count() != start {
		t.Fatalf("old reviewed choice overwrote current selection: %v", e)
	}
	plan, e = rt.PrepareConnect(ctx)
	if e != nil {
		t.Fatal(e)
	}
	scope, e = store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	legacyLock := filepath.Join(store.Directory, ".galaxy-write.lock")
	var hookError error
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v1/sessions" {
			hookError = os.WriteFile(legacyLock, []byte("isolated lock"), 0600)
		}
		return response, nil
	})
	if _, e = rt.ConnectReviewed(ctx, plan, &scope); fault.Code(e) != "native_legacy_write_lock_exists" || hookError != nil {
		t.Fatalf("failed save claimed connection: %v %v", e, hookError)
	}
	if e = os.Remove(legacyLock); e != nil {
		t.Fatal(e)
	}
	transport.setHook(nil)
	status, e = rt.Status(ctx, RuntimeStatusOptions{})
	if e != nil || status["connected"] != false || status["connectionChoice"].(map[string]any)["enabled"] != false {
		t.Fatalf("failed save left granted permission/session: %v %v", e, status)
	}
	snapshot, e := rt.ConnectReviewed(ctx, plan, &scope)
	if e != nil || snapshot == nil {
		t.Fatalf("reviewed connect: %v", e)
	}
	status, e = rt.Status(ctx, RuntimeStatusOptions{})
	if e != nil || status["connected"] != true || status["connectionChoice"].(map[string]any)["enabled"] != true {
		t.Fatalf("successful connection not committed: %v %v", e, status)
	}
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v2/identity/"+snapshot.SubjectID+"/control" && request.Header.Get("Authorization") != "" {
			_, hookError = rt.Disconnect(ctx)
		}
		return response, nil
	})
	if _, e = rt.Call(ctx, "/v2/identity/"+snapshot.SubjectID+"/control", nil, ConnectionCallOptions{Method: "GET"}); fault.Code(e) != "native_connection_selection_changed" || hookError != nil {
		t.Fatalf("in-flight reply survived withdrawal: %v %v", e, hookError)
	}
	transport.setHook(nil)
	start = transport.count()
	if _, e = rt.Restore(ctx); fault.Code(e) != "native_connection_choice_required" || transport.count() != start {
		t.Fatalf("withdrawn runtime resumed: %v", e)
	}
}

type runtimeNotificationFixture struct {
	calls   int
	failure error
}

func (n *runtimeNotificationFixture) Disable(context.Context) error { n.calls++; return n.failure }
func TestRuntimeDisconnectPropagatesLiveNotificationFailure(t *testing.T) {
	ctx := context.Background()
	store := materialStore(t)
	configuration := Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}
	rt, e := NewRuntime(store, configuration, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	adapter := &runtimeNotificationFixture{failure: connectionFailure("notification_process_shutdown_unconfirmed")}
	if e = rt.AttachNotifications(adapter); e != nil {
		t.Fatal(e)
	}
	if _, e = rt.Disconnect(ctx); fault.Code(e) != "notification_process_shutdown_unconfirmed" {
		t.Fatalf("notification failure hidden: %v", e)
	}
	if adapter.calls != 1 {
		t.Fatal("notification disable was not called exactly once")
	}
	path := connectionRecordPath(store.Directory, "native-selection:"+store.Endpoint)
	if present, _ := exists(path); present {
		t.Fatal("notification failure changed saved connection choice")
	}
	adapter.failure = nil
	result, e := rt.Disconnect(ctx)
	if e != nil || result["connected"] != false || result["remoteBindingRevoked"] != false || adapter.calls != 2 {
		t.Fatalf("notification-aware disconnect: %v %v", e, result)
	}
	if _, exists := result["systemRecallConfirmed"]; exists {
		t.Fatal("connection result invented OS recall evidence")
	}
}
