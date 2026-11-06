package native

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// This exercises the registered MCP purpose tools, including form elicitation,
// against the actual SDK HTTP peer. The peer fixture is synthetic; it is not a
// real host model, user approval surface or claim that the work goal succeeded.
func TestA2aWorkMCPCurrentLocalWorkContinuesOriginalSDKTaskAfterRestart(t *testing.T) {
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixture(t)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	newRuntime := func() *Runtime {
		t.Helper()
		r, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(r.Close)
		if _, e = r.Restore(ctx); e != nil {
			t.Fatal(e)
		}
		return r
	}
	r := newRuntime()
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	privateBackground := "private original conversation; never selected for external sharing"
	observed, e := store.ObserveWork(ctx, WorkObservationInput{GalaxyID: scope.Owner, Host: "opencode", SessionID: "purpose-sdk-current-work", SourceID: "actual-user-message", Kind: "message", Title: "Current local diagnostic work", Source: WorkSource{Kind: "user-statement"}, Content: &WorkContent{Excerpt: privateBackground, Retained: "excerpt"}, Details: json.RawMessage(`{}`)})
	if e != nil {
		t.Fatal(e)
	}
	workID := text(uploadObject(observed)["workId"])
	if !controlUUID(workID) {
		t.Fatal("real local observation did not retain a work reference", observed)
	}
	caseRequests := 0
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if strings.HasPrefix(request.URL.Path, "/v2/cases") {
			caseRequests++
		}
		return response, nil
	})
	t.Cleanup(func() { transport.setHook(nil) })
	peerURL, card := a2aOriginalPeer(t)
	configuration := []byte(`{"peers":[{"id":"peer","name":"Actual SDK fixture","endpoint":"https://peer.example.org/a2a","tenant":"fixture","peerPrincipal":"external-fixture-user","agentCard":` + card + `,"cardHash":"` + a2aHash([]byte(card)) + `","trustExpiresAt":` + strconv.FormatInt(now().UnixMilli()+3600000, 10) + `,"authentication":{"mode":"bearer-environment","variable":"GALAXY_A2A_PEER_SELECTED_TOKEN"}}]}`)
	sends, polls, choices := 0, 0, 0
	sent := []map[string]any{}
	post := func(ctx context.Context, endpoint string, body []byte, credential string) ([]byte, error) {
		if endpoint != "https://peer.example.org/a2a" || credential != "synthetic-peer-token" || strings.Contains(string(body), privateBackground) {
			return nil, a2aError("fixture peer scope changed or unselected local conversation was disclosed")
		}
		var request map[string]any
		if e := protocol.Decode(body, &request); e != nil {
			return nil, e
		}
		if request["method"] == "SendMessage" {
			sends++
			sent = append(sent, request)
		} else if request["method"] == "GetTask" {
			polls++
		}
		req, e := http.NewRequestWithContext(ctx, "POST", peerURL, bytes.NewReader(body))
		if e != nil {
			return nil, e
		}
		req.Header.Set("Content-Type", "application/json")
		response, e := http.DefaultClient.Do(req)
		if e != nil {
			return nil, e
		}
		defer response.Body.Close()
		return io.ReadAll(response.Body)
	}
	connect := func(runtime *Runtime) (*mcp.ClientSession, func()) {
		t.Helper()
		host, e := NewNativeA2a(runtime, configuration, A2aOptions{Post: post, ReadEnvironment: func(string) (string, bool) { return "synthetic-peer-token", true }, Now: now})
		if e != nil {
			t.Fatal(e)
		}
		server := mcp.NewServer(&mcp.Implementation{Name: "a2a-purpose-interop", Version: "1"}, nil)
		tools := &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}, browser: NewBrowserChoices(store, now)}
		stopCore := registerNativeA2aTools(server, tools, host)
		stopWork := registerNativeA2aWorkTools(server, tools, host)
		ct, st := mcp.NewInMemoryTransports()
		ss, e := server.Connect(ctx, st, nil)
		if e != nil {
			t.Fatal(e)
		}
		client := mcp.NewClient(&mcp.Implementation{Name: "a2a-purpose-client", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
			choices++
			return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
		}})
		cs, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
		if e != nil {
			t.Fatal(e)
		}
		closed := false
		close := func() {
			if !closed {
				closed = true
				_ = cs.Close()
				_ = ss.Close()
				stopWork()
				stopCore()
				tools.browser.Close()
			}
		}
		t.Cleanup(close)
		return cs, close
	}
	session, closeFirst := connect(r)
	call := func(name string, input map[string]any) map[string]any {
		t.Helper()
		result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: input})
		if e != nil || result == nil || result.IsError {
			t.Fatal(name, result, e)
		}
		return uploadObject(result.StructuredContent)
	}
	send := map[string]any{"action": "send", "peerId": "peer", "source": map[string]any{"kind": "local-work", "workId": workID}, "text": "input"}
	listed, e := session.ListTools(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	foundPrepare := false
	for _, tool := range listed.Tools {
		if tool.Name == "galaxy_a2a_work_prepare" {
			foundPrepare = true
			schemaRaw, e := protocol.Encode(tool.InputSchema)
			var schema map[string]any
			if e != nil || protocol.Decode(schemaRaw, &schema) != nil || remoteChatValidate(schema, send) != nil {
				t.Fatal("actual registered purpose schema does not accept local work input", tool.InputSchema, e)
			}
		}
	}
	if !foundPrepare {
		t.Fatal("actual MCP server did not register the purpose prepare tool")
	}
	invalid := identityClone(send)
	invalid["caseId"] = uuid.NewString()
	rejected, e := session.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_a2a_work_prepare", Arguments: invalid})
	if e != nil || rejected == nil || !rejected.IsError || sends != 0 || choices != 0 {
		t.Fatal("mixed invented formal source was accepted or caused a side effect", rejected, e, sends, choices)
	}
	preview := uploadObject(call("galaxy_a2a_work_prepare", send)["preview"])
	payload := uploadObject(uploadObject(preview["exact"])["payload"])
	if sends != 0 || choices != 0 || preview["caseId"] != nil || preview["attempt"] != nil || payload["attemptId"] != nil || uploadObject(payload["source"])["workId"] != workID {
		t.Fatal("purpose preparation sent work, fabricated a Case/Attempt or lost the real work source", preview, sends, choices)
	}
	execute := map[string]any{"handle": preview["handle"], "previewHash": preview["previewHash"]}
	call("galaxy_a2a_work_execute", execute)
	call("galaxy_a2a_work_execute", execute)
	if sends != 1 || choices != 1 {
		t.Fatal("purpose execution did not use one actual MCP choice or resent on repetition", sends, choices)
	}
	associationID := text(preview["associationId"])
	readInput := map[string]any{"action": "get", "peerId": "peer", "associationId": associationID}
	selected := uploadObject(call("galaxy_a2a_work_read", readInput)["selected"])
	link := uploadObject(selected["peer"])
	peerTask := uploadObject(link["peer"])
	taskID, contextID := text(peerTask["taskId"]), text(peerTask["contextId"])
	if taskID == "" || contextID == "" || peerTask["state"] != "input-required" || link["caseId"] != nil || link["attemptId"] != nil || selected["goalCompletion"] != "unconfirmed" {
		t.Fatal("purpose read did not return the actual pending SDK Task", selected)
	}
	// Recreate the runtime, A2A host and MCP sessions. The external SDK task and
	// durable original association remain; nothing is dispatched by restoration.
	closeFirst()
	r.Close()
	r = newRuntime()
	session, _ = connect(r)
	selected = uploadObject(call("galaxy_a2a_work_read", readInput)["selected"])
	link = uploadObject(selected["peer"])
	if uploadObject(link["peer"])["taskId"] != taskID || uploadObject(link["source"])["workId"] != workID || sends != 1 || choices != 1 {
		t.Fatal("restarted purpose reader lost the original Task/source or dispatched new work", selected, sends, choices)
	}
	call("galaxy_a2a_work_read", map[string]any{"action": "poll", "peerId": "peer", "associationId": associationID})
	if polls != 1 || sends != 1 || choices != 1 {
		t.Fatal("pending original Task was not queried through the purpose reader", polls, sends, choices)
	}
	reply := uploadObject(call("galaxy_a2a_work_prepare", map[string]any{"action": "reply", "peerId": "peer", "associationId": associationID, "text": "selected follow-up"})["preview"])
	replyPayload := uploadObject(uploadObject(reply["exact"])["payload"])
	if replyPayload["taskId"] != taskID || replyPayload["contextId"] != contextID || reply["caseId"] != nil || sends != 1 || choices != 1 {
		t.Fatal("purpose follow-up did not retain the observed protocol task/context", reply, sends, choices)
	}
	replyExecute := map[string]any{"handle": reply["handle"], "previewHash": reply["previewHash"]}
	call("galaxy_a2a_work_execute", replyExecute)
	call("galaxy_a2a_work_execute", replyExecute)
	selected = uploadObject(call("galaxy_a2a_work_read", readInput)["selected"])
	link = uploadObject(selected["peer"])
	peerTask = uploadObject(link["peer"])
	if sends != 2 || choices != 2 || peerTask["taskId"] != taskID || peerTask["state"] != "completed" || selected["goalCompletion"] != "unconfirmed" || selected["protocolTaskTerminal"] != true {
		t.Fatal("MCP follow-up replaced the original Task, resent, or promoted protocol completion to goal success", selected, sends, choices)
	}
	message := uploadObject(uploadObject(sent[1]["params"])["message"])
	if message["taskId"] != taskID || message["contextId"] != contextID {
		t.Fatal("actual SDK HTTP follow-up did not carry the recovered original Task", message)
	}
	output := a2aObject(peerTask["output"])
	resultMessage := a2aObject(a2aObject(output["status"])["message"])
	if text(a2aText(resultMessage["parts"])) != "Peer reply: selected follow-up" || len(uploadRows(link["operations"])) != 3 || caseRequests != 0 {
		t.Fatal("actual SDK output/original operations were lost or formal Case routes were used", selected, caseRequests)
	}
}
