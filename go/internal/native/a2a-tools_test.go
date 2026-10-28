package native

import (
	"context"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestA2aFiveConditionalOriginalToolsAndBranchDefaults(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	for _, action := range []string{"send", "reply", "cancel", "result"} {
		value := map[string]any{"peerId": "peer", "action": action}
		if action == "send" {
			value["caseId"] = id
			value["attemptId"] = id
			value["attemptVersion"] = 1
			value["text"] = "selected"
		} else {
			value["associationId"] = id
		}
		if action == "reply" {
			value["text"] = "reply"
		}
		if action == "result" {
			value["summary"] = "selected report"
			value["reportedOutcome"] = "inconclusive"
		}
		normalized, e := a2aNormalize("galaxy_a2a_prepare", value)
		if e != nil {
			t.Fatal(action, e)
		}
		if action != "result" {
			if _, ok := normalized["visibility"]; ok {
				t.Fatal("other branch injected result defaults", normalized)
			}
		} else if normalized["visibility"] != "Private" || normalized["limitations"] != "" {
			t.Fatal("result defaults missing", normalized)
		}
	}
	store, _ := NewStore(t.TempDir(), "https://official.invalid")
	runtime := commandRuntime(t, store)
	host, e := NewNativeA2a(runtime, []byte(`{"peers":[{"id":"peer","endpoint":"https://peer.invalid/a2a","peerPrincipal":"selected","agentCard":{},"cardHash":"0000000000000000000000000000000000000000000000000000000000000000","trustExpiresAt":2000000000000}]}`), A2aOptions{})
	if e != nil {
		t.Fatal(e)
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "a2a", Version: "1"}, nil)
	defer registerNativeA2aTools(server, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, host)()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	ss, e := server.Connect(context.Background(), serverTransport, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	session, e := client.Connect(context.Background(), clientTransport, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	listed, e := session.ListTools(context.Background(), nil)
	if e != nil || len(listed.Tools) != 5 {
		t.Fatal(listed, e)
	}
	result, e := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "galaxy_a2a_peers", Arguments: map[string]any{}})
	if e != nil || result.IsError {
		t.Fatal(result, e)
	}
	for _, name := range []string{"galaxy_a2a_peers", "galaxy_a2a_execute"} {
		result, e = session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: map[string]any{"operationId": id, "confirmed": true}})
		if e != nil || !result.IsError {
			t.Fatal("unknown/model confirmation accepted", name, result, e)
		}
	}
}
