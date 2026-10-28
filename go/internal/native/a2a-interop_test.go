package native

import (
	"bufio"
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
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func a2aOriginalPeer(t *testing.T) (string, string) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	script := `import {sdkPeer} from './packages/galaxy-a2a/test/sdk-peer.mjs';import {createServer} from 'node:http';const peer=await sdkPeer(),server=createServer(async(req,res)=>{try{let bodyJson='';for await(const b of req)bodyJson+=b;const value=await peer.post(peer.endpoint,{bodyJson,credential:'synthetic-peer-token'});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}catch{res.writeHead(500);res.end()}});await new Promise(r=>server.listen(0,'127.0.0.1',r));console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,cardJson:JSON.stringify(peer.card)}));process.stdin.resume();process.stdin.once('end',async()=>{await new Promise(r=>server.close(r));await peer.close()});`
	command := exec.Command("node", "--input-type=module", "-e", script)
	command.Dir = filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	stdout, e := command.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	stdin, e := command.StdinPipe()
	if e != nil {
		t.Fatal(e)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if e = command.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		done := make(chan error, 1)
		go func() { done <- command.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = command.Process.Kill()
			<-done
		}
	})
	line, e := bufio.NewReader(stdout).ReadBytes('\n')
	if e != nil {
		t.Fatal(e, stderr.String())
	}
	var meta map[string]any
	if e = protocol.Decode(line, &meta); e != nil {
		t.Fatal(e)
	}
	return text(meta["url"]), text(meta["cardJson"])
}
func TestA2aNativeGoCaseActualSDKUnknownOriginalHistoryAndResult(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := workUploadServiceFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	caseService := &cases.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now}
	origin, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(origin)
	next := cases.Handler{Service: caseService, Devices: devices, Next: fallback}
	handler := deviceauth.Handler{Service: devices, Next: next}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/consents" || r.URL.Path == "/v2/consents/receipt" {
			handler.ServeHTTP(w, r)
		} else {
			next.ServeHTTP(w, r)
		}
	}))
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	r, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
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
	submit := func(event map[string]any) {
		t.Helper()
		auth, e := r.AuthorizeReviewed(ctx, map[string]any{"requestId": uuid.NewString(), "action": "case.teaser.publish", "objectId": event["eventId"], "payloadJson": hostJSONString(event)}, &scope)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = NewNativeFacts(r).Call(ctx, "galaxy_case_v2_submit", map[string]any{"consentId": auth["consentId"], "payloadJson": auth["payloadJson"]}); e != nil {
			t.Fatal(e)
		}
	}
	caseID, attemptID := uuid.NewString(), uuid.NewString()
	submit(map[string]any{"schemaVersion": 2, "eventId": caseID, "caseId": caseID, "expectedVersion": 0, "actorId": scope.Owner, "kind": "case-created", "localRef": "a2a-fixture", "title": "Selected external review", "summary": "Private synthetic case", "source": map[string]any{"kind": "local", "reference": "a2a-fixture"}, "synthetic": true})
	submit(map[string]any{"schemaVersion": 2, "eventId": attemptID, "caseId": caseID, "expectedVersion": 1, "actorId": scope.Owner, "kind": "attempt-start", "role": "reviewer", "strategy": "One selected synthetic request", "inputScopeSummary": "Only chosen text", "permissionScope": []any{"selected-text"}})
	peerURL, card := a2aOriginalPeer(t)
	raw := `{"peers":[{"id":"peer","endpoint":"https://peer.example.org/a2a","tenant":"fixture","peerPrincipal":"external-fixture-user","agentCard":` + card + `,"cardHash":"` + a2aHash([]byte(card)) + `","trustExpiresAt":` + strconv.FormatInt(now().UnixMilli()+3600000, 10) + `,"authentication":{"mode":"bearer-environment","variable":"GALAXY_A2A_PEER_SELECTED_TOKEN"}}]}`
	sends, reads := 0, 0
	drop := true
	disconnectDuring := false
	var accepted map[string]any
	post := func(ctx context.Context, endpoint string, body []byte, credential string) ([]byte, error) {
		if endpoint != "https://peer.example.org/a2a" || credential != "synthetic-peer-token" {
			t.Fatal("peer scope or credential changed")
		}
		var query map[string]any
		_ = json.Unmarshal(body, &query)
		if query["method"] == "SendMessage" {
			sends++
		} else {
			reads++
		}
		req, _ := http.NewRequestWithContext(ctx, "POST", peerURL, bytes.NewReader(body))
		req.GetBody = nil
		req.Header.Set("Content-Type", "application/json")
		response, e := http.DefaultClient.Do(req)
		if e != nil {
			return nil, e
		}
		defer response.Body.Close()
		b, e := io.ReadAll(response.Body)
		if e != nil {
			return nil, e
		}
		if disconnectDuring && query["method"] == "SendMessage" {
			if _, e = r.Disconnect(context.Background()); e != nil {
				t.Fatal(e)
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
				t.Fatal("runtime selection change did not cancel external transport context")
			}
		}
		if drop && query["method"] == "SendMessage" {
			_ = protocol.Decode(b, &accepted)
			return nil, io.ErrUnexpectedEOF
		}
		return b, nil
	}
	host, e := NewNativeA2a(r, []byte(raw), A2aOptions{Post: post, ReadEnvironment: func(string) (string, bool) { return "synthetic-peer-token", true }, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer host.Close()
	preview, e := host.Prepare(ctx, map[string]any{"peerId": "peer", "action": "send", "caseId": caseID, "attemptId": attemptID, "attemptVersion": 1, "text": "selected task"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = host.ExecuteReviewed(ctx, preview, &scope); e == nil {
		t.Fatal("lost peer ACK claimed success")
	}
	if sends != 1 {
		t.Fatal("unknown was resent", sends)
	}
	link, e := preview.journal.get(ctx, text(preview.value["associationId"]))
	if e != nil || link["status"] != "unknown" {
		t.Fatal(link, e)
	}
	drop = false
	taskID := text(uploadObject(uploadObject(accepted["result"])["task"])["id"])
	op := uploadObject(uploadRows(link["operations"])[0])
	value, e := host.Read(ctx, map[string]any{"peerId": "peer", "action": "reconcile-task", "associationId": link["id"], "operationId": op["id"], "requestHash": op["requestHash"], "candidateTaskId": taskID})
	if e != nil || uploadObject(value)["state"] != "observed" || sends != 1 || reads != 1 {
		t.Fatal(value, e, sends, reads)
	}
	if _, e = host.Prepare(ctx, map[string]any{"peerId": "peer", "action": "send", "caseId": caseID, "attemptId": attemptID, "attemptVersion": 1, "text": "duplicate"}); e == nil {
		t.Fatal("same Attempt redispatched")
	}
	if _, e = host.Poll(ctx, "peer", text(link["id"])); e != nil {
		t.Fatal(e)
	}
	resultPreview, e := host.Prepare(ctx, map[string]any{"peerId": "peer", "action": "result", "associationId": link["id"], "summary": "Selected peer report only", "reportedOutcome": "succeeded"})
	if e != nil {
		t.Fatal(e)
	}
	caseWrites := 0
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v2/cases/events" {
			caseWrites++
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	if _, e = host.ExecuteReviewed(ctx, resultPreview, &scope); e == nil {
		t.Fatal("lost Case Result ACK claimed success")
	}
	transport.setHook(nil)
	reconciled, e := host.Read(ctx, map[string]any{"peerId": "peer", "action": "reconcile-result", "associationId": link["id"]})
	if e != nil || uploadObject(reconciled)["state"] != "acknowledged" || uploadObject(reconciled)["currentAccessGranted"] != false || caseWrites != 1 {
		t.Fatal("original Result receipt", reconciled, e, caseWrites)
	}
	readBack, e := NewNativeFacts(r).Call(ctx, "galaxy_case_v2_read", map[string]any{"caseId": caseID})
	if e != nil || a2aInteger(readBack["version"]) != 3 {
		t.Fatal("real Go Case Result missing", readBack, e)
	}
	secondAttempt := uuid.NewString()
	submit(map[string]any{"schemaVersion": 2, "eventId": secondAttempt, "caseId": caseID, "expectedVersion": 3, "actorId": scope.Owner, "kind": "attempt-start", "role": "reviewer", "strategy": "Selection may change during external I/O", "inputScopeSummary": "Only chosen text", "permissionScope": []any{"selected-text"}})
	interrupted, e := host.Prepare(ctx, map[string]any{"peerId": "peer", "action": "send", "caseId": caseID, "attemptId": secondAttempt, "attemptVersion": 1, "text": "work"})
	if e != nil {
		t.Fatal(e)
	}
	disconnectDuring = true
	if _, e = host.ExecuteReviewed(ctx, interrupted, &scope); e == nil {
		t.Fatal("late peer ACK survived selected connection change")
	}
	retained, e := interrupted.journal.get(ctx, text(interrupted.value["associationId"]))
	if e != nil || retained["status"] != "dispatching" || sends != 2 {
		t.Fatal("original dispatch reservation not retained", retained, e, sends)
	}
	before := reads
	if _, e = host.Poll(ctx, "peer", text(link["id"])); e == nil || reads != before {
		t.Fatal("disabled Native contacted peer", e)
	}
}
