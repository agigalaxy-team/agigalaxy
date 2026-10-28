package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeDeviceManagementOriginalJournalAndGoControl(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := workUploadServiceFixtureDatabase(t, dsn, true)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	service := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now, AllowedScopes: connectionBrowserScopes}
	original, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(original)
	control := deviceauth.Handler{Service: service, Next: fallback}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v2/identity/") {
			control.ServeHTTP(w, r)
		} else {
			fallback.ServeHTTP(w, r)
		}
	}))
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	d := NewNativeDeviceManagement(rt)
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var selectionBefore []byte
	if e = store.With(ctx, false, func(dir string) error {
		var e error
		selectionBefore, e = os.ReadFile(connectionRecordPath(dir, "native-selection:"+store.Endpoint))
		return e
	}); e != nil {
		t.Fatal(e)
	}
	current, e := d.Read(ctx, "current", "")
	if e != nil || uploadObject(current)["canManage"] != true {
		t.Fatalf("current control: %v", e)
	}
	if _, e = d.PrepareRevoke(ctx, scope.DeviceID); fault.Code(e) != "identity_last_controller" {
		t.Fatalf("last controller unexpectedly revocable: %v", e)
	}
	prepared, e := d.PrepareRevoke(ctx, meta.PeerDeviceID)
	if e != nil {
		t.Fatal(e)
	}
	first := uploadObject(prepared)
	firstID := text(first["operationId"])
	previewID := text(first["previewId"])
	var state string
	if e = pool.QueryRow(ctx, "SELECT state FROM identity_control_operations WHERE id=$1", firstID).Scan(&state); e != nil || state != "requested" {
		t.Fatalf("unsigned prepare committed: %v state=%s", e, state)
	}
	if _, e = d.StopRetryReviewed(ctx, firstID, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = d.ConfirmReviewed(ctx, previewID, &scope); e == nil {
		t.Fatal("stopped unsigned original signed")
	}
	if e = pool.QueryRow(ctx, "SELECT state FROM identity_control_operations WHERE id=$1", firstID).Scan(&state); e != nil || state != "requested" {
		t.Fatal("stop local falsely canceled server operation")
	}
	prepared, e = d.PrepareRevoke(ctx, meta.PeerDeviceID)
	if e != nil {
		t.Fatal(e)
	}
	next := uploadObject(prepared)
	operationID := text(next["operationId"])
	previewID = text(next["previewId"])
	stale := scope
	stale.Revision++
	if _, e = d.ConfirmReviewed(ctx, previewID, &stale); fault.Code(e) != "native_choice_binding_changed" {
		t.Fatalf("stale review accepted: %v", e)
	}
	var commits atomic.Int32
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v2/identity/control/commit" {
			commits.Add(1)
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	if _, e = d.ConfirmReviewed(ctx, previewID, &scope); e == nil {
		t.Fatal("lost control ACK claimed success")
	}
	retained, e := d.ConfirmReviewed(ctx, previewID, &scope)
	if e != nil || uploadObject(retained)["originalOperationRetained"] != true || commits.Load() != 1 {
		t.Fatalf("unknown control operation repeated: %v", e)
	}
	result, e := d.Read(ctx, "reconcile", operationID)
	if e != nil || uploadObject(uploadObject(result)["receipt"])["state"] != "committed" || commits.Load() != 1 {
		t.Fatalf("original receipt reconciliation: %v", e)
	}
	transport.setHook(nil)
	current, e = d.Read(ctx, "list", "")
	if e != nil {
		t.Fatal(e)
	}
	revoked := false
	for _, value := range uploadRows(uploadObject(current)["devices"]) {
		row := uploadObject(value)
		if row["deviceId"] == meta.PeerDeviceID && row["state"] == "revoked" && row["canRevoke"] == false {
			revoked = true
		}
	}
	if !revoked {
		t.Fatal("original target device remained active")
	}
	if e = store.With(ctx, false, func(dir string) error {
		after, e := os.ReadFile(connectionRecordPath(dir, "native-selection:"+store.Endpoint))
		if e == nil && identity.Digest(after) != identity.Digest(selectionBefore) {
			t.Fatal("revocation changed local owner/device choice")
		}
		return e
	}); e != nil {
		t.Fatal(e)
	}
	// The unchanged original Native reads Go's durable journal, and the original
	// verifier checks the actual Go-produced public control chain.
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	script := `import {readFile} from 'node:fs/promises';import {createNativeRuntime} from './packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';import {verifyIdentityControlChain} from './packages/galaxy-official/src/verification/identity-control.mjs';const dir=process.argv[1],origin=process.argv[2],f=JSON.parse(await readFile(dir+'/work-upload-fixture.json','utf8')),c=f.configuration;const native=await createNativeRuntime({...c,trustedKeys:new Map(Object.entries(c.trustedKeys)),fetch:(url,options)=>fetch(origin+new URL(url).pathname,options),now:()=>f.now,autoResumePrivateSync:false});const pending=await native.deviceManagement.pending(),state=await fetch(origin+'/v2/identity/'+pending.history[0].subjectId+'/control').then(x=>x.json());await verifyIdentityControlChain(state);console.log(JSON.stringify({pending,verified:true}));await native.close();`
	command := exec.Command("node", "--input-type=module", "-e", script, store.Directory, server.URL)
	command.Dir = root
	var originalDiagnostics strings.Builder
	command.Stderr = &originalDiagnostics
	out, e := command.Output()
	if e != nil {
		t.Fatalf("original journal reader: %v %s", e, originalDiagnostics.String())
	}
	var checked struct {
		Pending  map[string]any `json:"pending"`
		Verified bool           `json:"verified"`
	}
	if e = json.Unmarshal(out, &checked); e != nil || !checked.Verified || checked.Pending["active"] != nil || len(uploadRows(checked.Pending["history"])) != 2 {
		t.Fatalf("original journal incompatible: %v", e)
	}
}
