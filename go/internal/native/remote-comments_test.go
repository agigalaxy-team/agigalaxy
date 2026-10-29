package native

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"testing"
)

func TestRemoteCommentsNineOriginalContractsAndNoModelConfirmation(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	signed := func() map[string]any { return map[string]any{"consentId": id, "payloadJson": " {\"exact\":true} "} }
	event := signed()
	event["reportId"] = id
	cases := []map[string]any{{"name": "galaxy_comments_query", "input": map[string]any{"taskId": id, "query": "  selected question  "}}, {"name": "galaxy_comment_get", "input": map[string]any{"commentId": id}}, {"name": "galaxy_comment_submit", "input": signed()}, {"name": "galaxy_comment_receipt", "input": map[string]any{"operationId": id, "payloadHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}, {"name": "galaxy_comment_governance_config", "input": map[string]any{}}, {"name": "galaxy_comment_governance_query", "input": map[string]any{}}, {"name": "galaxy_comment_report", "input": signed()}, {"name": "galaxy_comment_governance_event", "input": event}, {"name": "galaxy_comment_governance_receipt", "input": map[string]any{"operationId": id, "payloadHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}
	original := nativeContractFixture(t)
	for index, item := range cases {
		name := text(item["name"])
		value, e := remoteCommentsNormalize(name, item["input"])
		if e != nil || !connectionEqual(value, uploadRows(original["normalized"])[index]) {
			t.Fatal(name, value, e)
		}
		path, body, method, e := remoteCommentsRequest(name, value)
		expected := uploadObject(uploadRows(original["calls"])[index])
		expectedMethod := "POST"
		if uploadObject(expected["options"])["method"] == "GET" {
			expectedMethod = "GET"
		}
		if e != nil || path != expected["path"] || !connectionEqual(body, expected["input"]) || method != expectedMethod {
			t.Fatal("original comment transport differs", name, path, body, method, e, expected)
		}
	}
	store, e := NewStore(t.TempDir(), "https://comments.invalid")
	if e != nil {
		t.Fatal(e)
	}
	runtime := commandRuntime(t, store)
	server := mcp.NewServer(&mcp.Implementation{Name: "comments", Version: "1"}, nil)
	registerRemoteCommentTools(server, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(context.Background(), st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "comments", Version: "1"}, nil)
	session, e := client.Connect(context.Background(), ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	registered, e := session.ListTools(context.Background(), nil)
	if e != nil || len(registered.Tools) != 9 {
		t.Fatal("incomplete comments domain", e)
	}
	materialCall(t, session, "galaxy_comment_submit", map[string]any{"consentId": id, "payloadJson": "{}", "confirmed": true}, true)
	materialCall(t, session, "galaxy_comment_governance_event", map[string]any{"consentId": id, "payloadJson": "{}"}, true)
}
