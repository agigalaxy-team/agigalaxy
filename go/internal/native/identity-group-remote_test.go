package native

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identitygroups"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeIdentityGroupRemoteOriginalToolsAndUnknownReceipt(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := workUploadServiceFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", "--input-type=module", "-e", `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {migrate} from './packages/galaxy-official/src/infrastructure/database.mjs';const u=new URL(process.argv[1]);if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated database required');const db=new pg.Pool({connectionString:u.href});try{await migrate(db,{roles:['api']})}finally{await db.end()}`, dsn)
	cmd.Dir = root
	if b, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("fixture migration: %v %s", e, b)
	}
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	groups := &identitygroups.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now}
	origin, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(origin)
	handler := identitygroups.Handler{Service: groups, Devices: devices, Next: fallback}
	lost := true
	beforeDrop := false
	packets := []map[string]any{}
	writes := 0
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/identity-groups/submit" {
			raw, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(raw))
			var packet map[string]any
			_ = json.Unmarshal(raw, &packet)
			packets = append(packets, packet)
			if beforeDrop {
				beforeDrop = false
				writes++
				c, _, _ := w.(http.Hijacker).Hijack()
				_ = c.Close()
				return
			}
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		if r.URL.Path == "/v2/identity-groups/submit" {
			writes++
			if lost && rec.Code == 200 {
				lost = false
				c, _, _ := w.(http.Hijacker).Hijack()
				_ = c.Close()
				return
			}
		}
		for k, v := range rec.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	}))
	defer httpServer.Close()
	transport.origin, _ = url.Parse(httpServer.URL)
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	server, e := NewRuntimeToolServer(store, rt)
	if e != nil {
		t.Fatal(e)
	}
	defer server.Close()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, serverTransport, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	choices := 0
	session, e := mcp.NewClient(&mcp.Implementation{Name: "isolated", Version: "test"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		choices++
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
	}}).Connect(ctx, clientTransport, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	listed, e := session.ListTools(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	expected := identityGroupContracts()
	var nativeContracts map[string]any
	_ = protocol.Decode([]byte(nativeIdentityGroupContractsJSON), &nativeContracts)
	for name, v := range nativeContracts {
		expected[name] = v
	}
	seen := map[string]bool{}
	for _, tool := range listed.Tools {
		if !strings.HasPrefix(tool.Name, "galaxy_identity_group_") {
			continue
		}
		if seen[tool.Name] || expected[tool.Name] == nil {
			t.Fatal("unexpected or duplicate identity-group tool", tool.Name)
		}
		seen[tool.Name] = true
	}
	if len(seen) != 12 || len(expected) != 12 {
		t.Fatalf("exact original identity-group 8+4: %v", seen)
	}
	before := transport.count()
	materialCall(t, session, "galaxy_identity_group_current", map[string]any{"confirmed": true}, true)
	materialCall(t, session, "galaxy_identity_group_source", map[string]any{"kind": "case-event", "id": uuid.NewString(), "version": 0}, true)
	if transport.count() != before {
		t.Fatal("invalid input sent HTTP")
	}
	current := materialCall(t, session, "galaxy_identity_group_current", map[string]any{}, false)
	var member string
	if e = owner.QueryRow(ctx, "SELECT id FROM subjects WHERE id<>$1 ORDER BY id LIMIT 1", scope.Owner).Scan(&member); e != nil {
		t.Fatal(e)
	}
	intent := map[string]any{"schemaVersion": 2, "operationId": uuid.NewString(), "groupId": uuid.NewString(), "kind": "create", "expectedVersion": 0, "previousOperationId": nil, "endpoint": scope.Endpoint, "issuedAt": meta.Now, "expiresAt": meta.Now + 300, "memberIds": []string{scope.Owner, member}, "canonicalDisplayId": scope.Owner, "visibility": "Private", "viewers": []any{}, "sourceRefs": []any{}, "attributionCorrections": []any{}, "purpose": "canonical-display-only", "capabilityMerged": false, "accessGranted": false}
	payload := hostJSONString(intent)
	proof := map[string]any{"schemaVersion": 2, "id": uuid.NewString(), "operationId": intent["operationId"], "groupId": intent["groupId"], "payloadHash": identity.Digest([]byte(payload)), "endpoint": scope.Endpoint, "subjectId": scope.Owner, "keyId": current["keyId"], "epoch": current["epoch"], "decision": "approve", "issuedAt": meta.Now, "expiresAt": meta.Now + 300}
	proofText := hostJSONString(proof)
	lease, e := rt.connection.lease(ctx, true)
	if e != nil {
		t.Fatal(e)
	}
	signature, e := rt.connection.sign(ctx, lease, proofText, identitygroups.SignatureType)
	if e != nil {
		t.Fatal(e)
	}
	materialCall(t, session, "galaxy_identity_group_submit", map[string]any{"payloadJson": payload, "proofJson": proofText, "signature": signature}, true)
	if writes != 1 {
		t.Fatal("unknown POST resent", writes)
	}
	result := materialCall(t, session, "galaxy_identity_group_receipt", map[string]any{"operationId": intent["operationId"], "payloadHash": proof["payloadHash"]}, false)
	if result["state"] != "pending" || len(uploadRows(result["acknowledgedProofIds"])) != 1 {
		t.Fatal("accurate original receipt", result)
	}
	materialCall(t, session, "galaxy_identity_group_proposal", map[string]any{"operationId": intent["operationId"]}, false)
	materialCall(t, session, "galaxy_identity_group_query", map[string]any{}, false)
	materialCall(t, session, "galaxy_identity_group_resolve", map[string]any{"subjectId": scope.Owner}, false)
	if choices != 0 {
		t.Fatal("ordinary signed tools added confirmation", choices)
	}

	// Existing local preview flow: human review signs only the displayed scope.
	pending := func() []any {
		t.Helper()
		r, e := session.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_identity_group_native_recover", Arguments: map[string]any{"action": "pending"}})
		if e != nil || r.IsError {
			t.Fatalf("pending: %v %v", e, r)
		}
		var rows []any
		if e = protocol.Decode([]byte(r.Content[0].(*mcp.TextContent).Text), &rows); e != nil {
			t.Fatal(e)
		}
		return rows
	}
	makeIntent := func() map[string]any {
		p := identityClone(intent)
		p["operationId"] = uuid.NewString()
		p["groupId"] = uuid.NewString()
		return p
	}
	prepared := materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "intent", "input": makeIntent()}, false)
	lost = true
	materialCall(t, session, "galaxy_identity_group_native_execute", map[string]any{"previewId": prepared["previewId"]}, true)
	count := writes
	repeat := materialCall(t, session, "galaxy_identity_group_native_execute", map[string]any{"previewId": prepared["previewId"]}, false)
	if repeat["state"] != "original-operation-needs-reconciliation" || writes != count || choices != 1 {
		t.Fatal("prepared handle resent or reviewed twice", repeat, writes, choices)
	}
	rows := pending()
	if len(rows) != 1 {
		t.Fatal("unknown local journal", rows)
	}

	// The original Native Store and original SDK read the Go journal directly.
	originalRead := exec.Command("node", "--input-type=module", "-e", `import {createNativeStore} from './packages/galaxy-edge-mcp/src/native-v2/store.mjs';import {createIdentityGroupClientV2} from './packages/galaxy-official/src/clients/identity-group-v2.mjs';const [dir,endpoint,subjectId,bindingId]=process.argv.slice(1),store=createNativeStore(dir),prefix='native-identity-group:'+endpoint+':'+subjectId+':';const client=createIdentityGroupClientV2({api:{endpoint,snapshot:()=>({subjectId,bindingId}),call:()=>{throw Error('read-only journal fixture must not request network')}},subjectId,sign:()=>{throw Error('read-only')},getLocal:name=>store.get(prefix+name),putLocal:()=>{throw Error('read-only')}});console.log(JSON.stringify(await client.pending()));`, meta.Configuration.DataDirectory, scope.Endpoint, scope.Owner, lease.bindingID)
	originalRead.Dir = root
	var journalErrors bytes.Buffer
	originalRead.Stderr = &journalErrors
	raw, e := originalRead.Output()
	if e != nil {
		t.Fatalf("original journal reader: %v %s", e, journalErrors.String())
	}
	var originalRows []any
	if e = protocol.Decode(raw, &originalRows); e != nil || !connectionEqual(originalRows, rows) {
		t.Fatalf("original SDK journal projection changed: %v", e)
	}
	id := text(uploadObject(rows[0])["proofId"])
	recovered := materialCall(t, session, "galaxy_identity_group_native_recover", map[string]any{"action": "retry", "proofId": id}, false)
	if recovered["ownApprovalAcknowledged"] != true || writes != count || len(pending()) != 0 {
		t.Fatal("known original did not reconcile", recovered, writes)
	}
	// Absent is not cancellation. An explicit retry retains exact old signed bytes.
	prepared = materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "intent", "input": makeIntent()}, false)
	beforeDrop = true
	materialCall(t, session, "galaxy_identity_group_native_execute", map[string]any{"previewId": prepared["previewId"]}, true)
	rows = pending()
	id = text(uploadObject(rows[0])["proofId"])
	count = writes
	absent := materialCall(t, session, "galaxy_identity_group_native_recover", map[string]any{"action": "reconcile", "proofId": id}, false)
	if absent["state"] != "absent" || absent["serverCancellationConfirmed"] != false || writes != count {
		t.Fatal("absent misreported", absent)
	}
	materialCall(t, session, "galaxy_identity_group_native_recover", map[string]any{"action": "retry", "proofId": id}, false)
	if writes != count+1 || !connectionEqual(packets[len(packets)-1], packets[len(packets)-2]) || len(pending()) != 0 {
		t.Fatal("explicit retry changed original bytes")
	}
	// Renewal retains the old proof and operation, and requires a new real choice.
	prepared = materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "intent", "input": makeIntent()}, false)
	beforeDrop = true
	materialCall(t, session, "galaxy_identity_group_native_execute", map[string]any{"previewId": prepared["previewId"]}, true)
	rows = pending()
	oldID := text(uploadObject(rows[0])["proofId"])
	oldPacket := packets[len(packets)-1]
	renewed := materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "renew", "proofId": oldID}, false)
	materialCall(t, session, "galaxy_identity_group_native_execute", map[string]any{"previewId": renewed["previewId"]}, false)
	newPacket := packets[len(packets)-1]
	if oldPacket["payloadJson"] != newPacket["payloadJson"] || oldPacket["proofJson"] == newPacket["proofJson"] || choices != 4 {
		t.Fatal("renewal changed original operation or skipped review", choices)
	}
	count = writes
	materialCall(t, session, "galaxy_identity_group_native_recover", map[string]any{"action": "retry", "proofId": oldID}, true)
	if writes != count {
		t.Fatal("superseded signature resent")
	}

	prepared = materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "intent", "input": makeIntent()}, false)
	beforeDrop = true
	materialCall(t, session, "galaxy_identity_group_native_execute", map[string]any{"previewId": prepared["previewId"]}, true)
	rows = pending()
	stoppedID := text(uploadObject(rows[0])["proofId"])
	count = writes
	stopped := materialCall(t, session, "galaxy_identity_group_native_recover", map[string]any{"action": "stop-local-retry", "proofId": stoppedID}, false)
	if stopped["localRetryStopped"] != true || stopped["serverCancellationConfirmed"] != false || writes != count {
		t.Fatal("stop local retry changed remote operation", stopped)
	}
	materialCall(t, session, "galaxy_identity_group_native_recover", map[string]any{"action": "retry", "proofId": stoppedID}, true)
	materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "renew", "proofId": stoppedID}, true)
	if writes != count {
		t.Fatal("stopped proof resent")
	}
	direct := NewNativeIdentityGroupOperations(rt)
	defer direct.Close()
	stalePreview, e := direct.Prepare(ctx, map[string]any{"action": "intent", "input": makeIntent()})
	if e != nil {
		t.Fatal(e)
	}
	staleScope := scope
	staleScope.Revision++
	if _, e = direct.ExecuteReviewed(ctx, text(stalePreview["previewId"]), &staleScope); e == nil || writes != count {
		t.Fatal("stale choice scope accepted", e)
	}
	canceled := materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "intent", "input": makeIntent()}, false)
	materialCall(t, session, "galaxy_identity_group_native_cancel_preview", map[string]any{"previewId": canceled["previewId"]}, false)
	if writes != count {
		t.Fatal("cancel preview sent remote cancellation")
	}

	response := materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "response", "operationId": intent["operationId"], "decision": "cancel"}, false)
	responseReceipt := materialCall(t, session, "galaxy_identity_group_native_execute", map[string]any{"previewId": response["previewId"]}, false)
	if responseReceipt["operationState"] != "cancelled" || responseReceipt["serverCancellationConfirmed"] != true {
		t.Fatal("original proposal response failed", responseReceipt)
	}
	offlinePreview, e := direct.Prepare(ctx, map[string]any{"action": "intent", "input": makeIntent()})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = rt.Disconnect(ctx); e != nil {
		t.Fatal(e)
	}
	beforeCancel := transport.count()
	offlineCanceled, e := direct.CancelPreview(ctx, text(offlinePreview["previewId"]))
	if e != nil || offlineCanceled["state"] != "canceled-before-signing" || transport.count() != beforeCancel {
		t.Fatal("same-owner offline preview cancel failed", e)
	}
	before = transport.count()
	materialCall(t, session, "galaxy_identity_group_query", map[string]any{}, true)
	if transport.count() != before {
		t.Fatal("disabled connection sent group query")
	}
	before = transport.count()
	server.Close()
	materialCall(t, session, "galaxy_identity_group_native_prepare", map[string]any{"action": "intent", "input": makeIntent()}, true)
	if transport.count() != before {
		t.Fatal("closed native service sent identity-group request")
	}

}
