package native

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type workerFailureTransport struct {
	next         http.RoundTripper
	failConsent  bool
	consentPosts int
}

func (w *workerFailureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path == "/v1/consents" {
		w.consentPosts++
		if w.failConsent {
			w.failConsent = false
			return nil, io.ErrUnexpectedEOF
		}
	}
	return w.next.RoundTrip(r)
}

func TestWorkerPackActualSourcesAndDoubleAbsentRenewal(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := workUploadServiceFixtureDatabase(t, dsn)
	clock := meta.Now
	now := func() time.Time { return time.Unix(clock, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	configs := &configurations.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now, ConfigurationCondition: configs.ConditionWithin}
	cs.Sources = func(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref, _ cases.Object) (cases.Object, error) {
		if ref["kind"] != "configuration" {
			return nil, fault.New("source_access_unavailable", 503)
		}
		return configs.RequireReferenceWithin(ctx, tx, a, ref)
	}
	bs := &builders.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now, Cases: cs, Configurations: configs}
	origin, _ := url.Parse(meta.Origin)
	next := builders.Handler{Service: bs, Devices: devices, Next: configurations.Handler{Service: configs, Devices: devices, Next: cases.Handler{Service: cs, Devices: devices, Next: httputil.NewSingleHostReverseProxy(origin)}}}
	dh := deviceauth.Handler{Service: devices, Next: next}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/consents" || r.URL.Path == "/v2/consents/receipt" {
			dh.ServeHTTP(w, r)
		} else {
			next.ServeHTTP(w, r)
		}
	}))
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	ft := &workerFailureTransport{next: transport}
	r, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: ft}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: "work-content"}, &scope); e != nil {
		t.Fatal(e)
	}
	command := exec.Command("node", "--input-type=module", "-e", `import {builderDeclaration} from './packages/galaxy-official/test/builders-workflow.mjs';import {packFor,supportFor} from './packages/galaxy-official/test/builder-support-v2-workflow.mjs';import {configurationExample} from './packages/galaxy-official/test/configuration-v2-workflow.mjs';const declaration=builderDeclaration('worker',process.argv[1]);console.log(JSON.stringify({declaration,support:supportFor(declaration),manifest:packFor(declaration),configuration:configurationExample({subjectId:process.argv[1]})}));`, scope.Owner)
	command.Dir, _ = filepath.Abs("../../..")
	raw, e := command.Output()
	if e != nil {
		t.Fatal(e)
	}
	var shapes map[string]any
	if protocol.Decode(raw, &shapes) != nil {
		t.Fatal("source shapes")
	}
	submit := func(path, action string, event map[string]any, public bool) map[string]any {
		t.Helper()
		objectID := event["operationId"]
		if objectID == nil {
			objectID = event["eventId"]
		}
		if objectID == nil {
			objectID = event["id"]
		}
		in := map[string]any{"requestId": uuid.NewString(), "action": action, "objectId": objectID, "payloadJson": hostJSONString(event)}
		if public {
			in["visibility"] = "Public"
		}
		auth, e := r.AuthorizeReviewed(ctx, in, &scope)
		if e != nil {
			t.Fatal(path, e)
		}
		out, e := r.Call(ctx, path, map[string]any{"consentId": auth["consentId"], "payloadJson": auth["payloadJson"]}, ConnectionCallOptions{})
		if e != nil {
			t.Fatal(path, e)
		}
		return map[string]any{"result": out, "hash": identity.Digest([]byte(text(auth["payloadJson"])))}
	}
	config := uploadObject(shapes["configuration"])
	config["observedAt"] = now().UTC().Format("2006-01-02T15:04:05.000Z")
	submit("/v2/configurations/events", "configuration.publish", config, true)
	builderID, declID := uuid.NewString(), uuid.NewString()
	decl := map[string]any{"id": declID, "builderId": builderID, "expectedRevision": 0, "kind": "declare", "declaration": shapes["declaration"]}
	declHash := submit("/v1/builders/events", "builder.publish", decl, true)["hash"]
	submit("/v2/builders/support/events", "builder.publish", map[string]any{"id": uuid.NewString(), "builderId": builderID, "expectedRevision": 1, "kind": "support-profile", "declarationId": declID, "declarationHash": declHash, "support": shapes["support"]}, true)
	manifestID := uuid.NewString()
	manifest := uploadObject(shapes["manifest"])
	manifestHash := submit("/v2/builders/support/events", "builder.publish", map[string]any{"id": manifestID, "builderId": builderID, "expectedRevision": 2, "kind": "pack-manifest", "declarationId": declID, "declarationHash": declHash, "manifest": manifest}, true)["hash"]
	pack := map[string]any{"builderId": builderID, "manifestId": manifestID, "manifestHash": manifestHash}
	peerURL, card := a2aOriginalPeer(t)
	a2aconfig := `{"peers":[{"id":"peer","endpoint":"https://peer.example.org/a2a","tenant":"fixture","peerPrincipal":"external-fixture-user","agentCard":` + card + `,"cardHash":"` + a2aHash([]byte(card)) + `","trustExpiresAt":` + strconv.FormatInt(now().UnixMilli()+3600000, 10) + `,"authentication":{"mode":"bearer-environment","variable":"GALAXY_A2A_PEER_SELECTED_TOKEN"}}]}`
	sends := 0
	post := func(ctx context.Context, endpoint string, body []byte, credential string) ([]byte, error) {
		if endpoint != "https://peer.example.org/a2a" || credential != "synthetic-peer-token" {
			t.Fatal("peer scope")
		}
		var q map[string]any
		_ = json.Unmarshal(body, &q)
		if q["method"] == "SendMessage" {
			sends++
		}
		req, _ := http.NewRequestWithContext(ctx, "POST", peerURL, bytes.NewReader(body))
		req.GetBody = nil
		req.Header.Set("Content-Type", "application/json")
		response, e := http.DefaultClient.Do(req)
		if e != nil {
			return nil, e
		}
		defer response.Body.Close()
		return io.ReadAll(response.Body)
	}
	workerConfig, _ := protocol.Encode(map[string]any{"workers": []any{map[string]any{"id": "worker", "peerId": "peer", "pack": pack, "sourceHash": manifest["sha256"], "version": manifest["version"]}}})
	// The actual CLI factory must expose the same conditional tools, not just
	// this test's direct registration below. Construction never contacts a peer.
	r.config.WorkerPacks, r.config.A2A = workerConfig, []byte(a2aconfig)
	entry, err := NewRuntimeToolServer(store, r)
	if err != nil {
		t.Fatal("actual Native Worker entry", err)
	}
	listClient, listServer := mcp.NewInMemoryTransports()
	entrySession, err := entry.Connect(ctx, listServer, nil)
	if err != nil {
		t.Fatal(err)
	}
	listing, err := mcp.NewClient(&mcp.Implementation{Name: "entry-list", Version: "1"}, nil).Connect(ctx, listClient, nil)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := listing.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range listed.Tools {
		names[tool.Name] = true
	}
	for _, name := range []string{"galaxy_worker_host_read", "galaxy_worker_host_prepare", "galaxy_worker_host_execute", "galaxy_worker_host_abort_local"} {
		if !names[name] {
			t.Fatal("Worker missing from actual entry", name)
		}
	}
	_ = listing.Close()
	_ = entrySession.Close()
	entry.Close()
	entry.Close() // repeated close retains the runtime and does not deadlock
	host, e := NewNativeWorkerHost(r, workerConfig, []byte(a2aconfig), A2aOptions{Post: post, ReadEnvironment: func(string) (string, bool) { return "synthetic-peer-token", true }, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer host.Close()
	toolServer := mcp.NewServer(&mcp.Implementation{Name: "worker-test", Version: "1"}, nil)
	registerNativeWorkerTools(toolServer, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, host)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := toolServer.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	choices := 0
	client := mcp.NewClient(&mcp.Implementation{Name: "worker-test", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		choices++
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
	}})
	session, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	toolCall := func(name string, input any) map[string]any {
		t.Helper()
		v, e := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: input})
		if e != nil || v.IsError {
			t.Fatal(name, v, e)
		}
		return uploadObject(v.StructuredContent)
	}
	startCount := 0
	start := func() string {
		t.Helper()
		caseID, attemptID := uuid.NewString(), uuid.NewString()
		submit("/v2/cases/events", "case.teaser.publish", map[string]any{"schemaVersion": 2, "eventId": caseID, "caseId": caseID, "expectedVersion": 0, "actorId": scope.Owner, "kind": "case-created", "localRef": caseID, "title": "Selected synthetic Worker", "summary": "Only selected source", "source": map[string]any{"kind": "local", "reference": caseID}, "synthetic": true}, false)
		submit("/v2/cases/events", "case.teaser.publish", map[string]any{"schemaVersion": 2, "eventId": attemptID, "caseId": caseID, "expectedVersion": 1, "actorId": scope.Owner, "kind": "attempt-start", "role": "runner", "strategy": "Selected configured Pack", "configurationRef": map[string]any{"id": config["id"], "version": 1}, "inputScopeSummary": "Only chosen text", "permissionScope": []any{"selected-text"}}, false)
		input := map[string]any{"action": "start", "workerId": "worker", "caseId": caseID, "attemptId": attemptID, "attemptVersion": 1, "purpose": "Explicit synthetic review", "text": "selected task"}
		var p *WorkerPreview
		if startCount == 0 {
			before := sends
			preview := uploadObject(toolCall("galaxy_worker_host_prepare", input)["preview"])
			if sends != before || choices != 0 || !strings.Contains(text(uploadObject(preview["exact"])["payloadJson"]), "selected task") {
				t.Fatal("prepare lost exact review or dispatched", preview, sends, choices)
			}
			p = host.previews[text(preview["handle"])]
			selected := map[string]any{"handle": preview["handle"], "previewHash": preview["previewHash"]}
			toolCall("galaxy_worker_host_execute", selected)
			toolCall("galaxy_worker_host_execute", selected)
			if sends != before+1 || choices != 1 {
				t.Fatal("MCP retry dispatched or requested another choice", sends, choices)
			}
		} else {
			p, e = host.Prepare(ctx, input)
			if e != nil {
				t.Fatal(e)
			}
			before := sends
			if _, e = host.ExecuteReviewed(ctx, p, &scope); e != nil {
				t.Fatal(e)
			}
			if sends != before+1 {
				t.Fatal("dispatch count", sends)
			}
			if _, e = host.ExecuteReviewed(ctx, p, &scope); e == nil || sends != before+1 {
				t.Fatal("used preview dispatched")
			}
		}
		startCount++
		id := text(p.row["associationId"])
		result, e := host.Prepare(ctx, map[string]any{"action": "result", "associationId": id, "summary": "Participant reported only", "reportedOutcome": "partial"})
		if e != nil {
			t.Fatal(e)
		}
		if _, e = host.ExecuteReviewed(ctx, result, &scope); e != nil {
			t.Fatal(e)
		}
		return id
	}
	for round := 0; round < 2; round++ {
		id := start()
		p, e := host.Prepare(ctx, map[string]any{"action": "use", "associationId": id})
		if e != nil {
			t.Fatal(e)
		}
		ft.failConsent = true
		if _, e = host.ExecuteReviewed(ctx, p, &scope); e == nil {
			t.Fatal("lost Consent claimed success")
		}
		_, leaseDone, l, e := r.identityLease(ctx, false)
		if e != nil {
			t.Fatal(e)
		}
		state, e := workerUseLoad(ctx, l)
		if e != nil {
			t.Fatal(e)
		}
		original := workerOrdered(state.Values()["active"])
		old := workerClone(original)
		before := ft.consentPosts
		receipt, e := workerUseReceipt(ctx, l, original.Values())
		if e != nil || receipt["state"] != "absent" {
			t.Fatal(receipt, e)
		}
		consent, e := workerConsentReceipt(ctx, l, uploadObject(original.Values()["prepared"]))
		if e != nil || consent["state"] != "absent" {
			t.Fatal(consent, e)
		}
		leaseDone()
		if round == 0 {
			clock += 301
		}
		if round == 1 {
			// The original handshake fixture uses a fixed clock; handshake at
			// that same clock, then resume the local renewal clock afterward.
			renewalClock := clock
			clock = meta.Now
			if _, e = r.Disconnect(ctx); e != nil {
				t.Fatal(e)
			}
			plan, e := r.PrepareConnect(ctx)
			if e != nil {
				t.Fatal(e)
			}
			scope, e = store.ChoiceScope(ctx)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = r.ConnectReviewed(ctx, plan, &scope); e != nil {
				t.Fatal(e)
			}
			clock = renewalClock
			scope, e = store.ChoiceScope(ctx)
			if e != nil {
				t.Fatal(e)
			}
		}
		retry, e := host.Prepare(ctx, map[string]any{"action": "use", "associationId": id})
		if e != nil {
			t.Fatal(e)
		}
		out, e := host.ExecuteReviewed(ctx, retry, &scope)
		if e != nil {
			t.Fatal(e)
		}
		if round == 1 {
			if out["reason"] != "original-binding-changed" || ft.consentPosts != before {
				t.Fatal("binding change reauthorized", out, ft.consentPosts, before)
			}
			continue
		}
		if out["state"] != "acknowledged" || ft.consentPosts != before+1 {
			t.Fatal(out, ft.consentPosts, before)
		}
		// The original request and business hash survive renewal; only Consent changes.
		if retry.row["packUse"] == nil || a2aObject(retry.row["packUse"])["operationId"] != a2aObject(old)["operationId"] || a2aObject(retry.row["packUse"])["payloadHash"] != a2aObject(old)["payloadHash"] {
			t.Fatal("original business changed")
		}
	}
}
