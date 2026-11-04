package native

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestWatchPendingForegroundRereadAndWithdrawnWindowAck(t *testing.T) {
	ctx := context.Background()
	store, meta, transport := connectionServiceFixture(t)
	runtime, err := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if _, err = runtime.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	operation, release, lease, err := runtime.identityLease(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	room, grant := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	items := []any{map[string]any{"messageId": "00000000-0000-4000-8000-000000000003", "subjectId": "fixture-other-person", "state": "accepted", "sequence": "5", "text": "A current room message"}}
	cursorCalls := 0
	// Keep the real local connection fixture; script only the room reads and
	// cursor receipt needed to exercise the Native pending-window contract.
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		var value map[string]any
		readInput := func() map[string]any {
			if request.GetBody == nil {
				t.Error("watch request has no replayable JSON body")
				return nil
			}
			body, err := request.GetBody()
			if err != nil {
				t.Error(err)
				return nil
			}
			defer body.Close()
			raw, err := io.ReadAll(body)
			if err != nil {
				t.Error(err)
				return nil
			}
			input, err := connectionObject(raw)
			if err != nil {
				t.Error(err)
			}
			return input
		}
		switch request.URL.Path {
		case "/v2/chat/rooms/" + room + "/agent-grants":
			value = map[string]any{"items": []any{map[string]any{"grantId": grant, "state": "active", "bindingId": lease.connection.bindingID, "expiresAt": meta.Now + 3600}}}
		case "/v2/chat/rooms/" + room + "/history":
			if input := readInput(); input["after"] != "0" || input["agentGrantId"] != grant {
				t.Error("pending reread changed its original start or grant", input)
			}
			value = map[string]any{"messages": items, "scannedThrough": "5", "complete": true}
		case "/v2/chat/rooms/" + room + "/cursor":
			cursorCalls++
			if input := readInput(); input["kind"] != "agent" || input["agentGrantId"] != grant || input["sequence"] != "5" {
				t.Error("ACK changed the original Agent cursor window", input)
			}
			value = map[string]any{"kind": "agent", "agentGrantId": grant, "sequence": "5"}
		default:
			return response, nil
		}
		response.Body.Close()
		response.StatusCode = http.StatusOK
		response.Body = io.NopCloser(strings.NewReader(hostJSONString(value)))
		return response, nil
	})
	watch := NewNativeWatch(runtime)
	started, err := watch.StartReviewed(operation, lease, map[string]any{"roomId": room, "agentGrantId": grant, "purpose": "Read current room material"}, &lease.scope)
	if err != nil {
		t.Fatal(err)
	}
	id := text(uploadObject(uploadRows(started["items"])[0])["id"])
	first, err := watch.Check(operation, lease, id, false, false)
	if err != nil || first["state"] != "work-ready" {
		t.Fatal("initial work not prepared", first, err)
	}
	workID := text(uploadObject(first["work"])["workId"])
	before, err := watch.row(operation, lease, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, withdrawn := range []bool{false, true} {
		if withdrawn {
			items = []any{}
		}
		result, err := watch.Check(operation, lease, id, false, false)
		work := uploadObject(result["work"])
		if err != nil || result["state"] != "work-ready" || work["workId"] != workID || work["after"] != "0" || work["next"] != "5" || work["sourceChanged"] != withdrawn {
			t.Fatal("original pending work cannot be reread", result, err)
		}
		wantItems := 1
		if withdrawn {
			wantItems = 0
		}
		if len(uploadRows(work["items"])) != wantItems {
			t.Fatal("reread did not expose current permitted material", work)
		}
		after, err := watch.row(operation, lease, id)
		if err != nil || !connectionEqual(before["pending"], after["pending"]) || before["nextCheckAt"] != after["nextCheckAt"] || cursorCalls != 0 {
			t.Fatal("reading changed or acknowledged the pending window", after, err)
		}
	}
	if _, err = watch.VerifyHostWork(operation, lease, id, workID); fault.Code(err) != "watch_source_changed" {
		t.Fatal("analysis execution accepted changed source material", err)
	}
	acked, err := watch.Ack(operation, lease, id, workID)
	if err != nil || acked["state"] != "processed" || acked["humanRead"] != false || cursorCalls != 1 {
		t.Fatal("explicit Agent ACK cannot finish the withdrawn original window", acked, err)
	}
	after, err := watch.row(operation, lease, id)
	if err != nil || after["pending"] != nil || after["after"] != "5" {
		t.Fatal("ACK did not clear the original pending window", after, err)
	}
}

func TestRemoteChatOriginalInputDefaultsRefinementsAndStrictTools(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	cases := []map[string]any{}
	add := func(name string, input map[string]any) {
		cases = append(cases, map[string]any{"name": name, "input": input})
	}
	add("galaxy_chat_create", map[string]any{"roomId": id, "operationId": id, "title": "  银河  "})
	add("galaxy_chat_create", map[string]any{"roomId": id, "operationId": id, "title": strings.Repeat(" ", 200) + "title"})
	add("galaxy_chat_create", map[string]any{"roomId": id, "operationId": id, "title": strings.Repeat("😀", 61)})
	for _, limit := range []any{"0x10", true, []any{"2"}, "invalid", 101} {
		add("galaxy_chat_history", map[string]any{"roomId": id, "limit": limit})
	}
	add("galaxy_chat_history", map[string]any{"roomId": id, "before": "5"})
	add("galaxy_chat_history", map[string]any{"roomId": id, "latest": true, "after": "1"})
	add("galaxy_chat_history", map[string]any{"roomId": id, "latest": true, "before": "5"})
	add("galaxy_chat_send", map[string]any{"roomId": id, "agentGrantId": id, "clientMessageId": id, "text": "\ufeff \n"})
	add("galaxy_chat_send", map[string]any{"roomId": id, "agentGrantId": id, "clientMessageId": id, "text": "", "attachments": []any{map[string]any{"id": id, "sha256": strings.Repeat("a", 64)}}})
	add("galaxy_chat_send", map[string]any{"roomId": id, "agentGrantId": id, "clientMessageId": id, "text": "content", "unknown": true})
	original := readNativeContractFixture(t, "chat-input-v1.json")
	for i, item := range uploadRows(original["items"]) {
		expected := uploadObject(item)
		value, e := remoteChatNormalize(text(cases[i]["name"]), cases[i]["input"])
		if (e == nil) != (expected["ok"] == true) {
			t.Fatalf("parse differs %d: %v %v original=%v", i, value, e, expected)
		}
		if e == nil && !connectionEqual(value, expected["value"]) {
			t.Fatalf("defaults differ %d: %v / %v", i, value, expected)
		}
	}
	store, e := NewStore(t.TempDir(), "https://chat.invalid")
	if e != nil {
		t.Fatal(e)
	}
	runtime := commandRuntime(t, store)
	server := mcp.NewServer(&mcp.Implementation{Name: "chat", Version: "1"}, nil)
	registerRemoteChatTools(server, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(context.Background(), st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "chat", Version: "1"}, nil)
	cs, e := client.Connect(context.Background(), ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	tools, e := cs.ListTools(context.Background(), nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(tools.Tools) != 23 {
		t.Fatalf("expected 23 chat tools, got %d", len(tools.Tools))
	}
	materialCall(t, cs, "galaxy_chat_send", map[string]any{"roomId": id, "agentGrantId": id, "clientMessageId": id, "text": "okay", "confirmed": true}, true)
	if _, e = os.Stat(filepath.Join(store.Directory, "native-v2")); !os.IsNotExist(e) {
		t.Fatal("invalid schema created identity")
	}
}
