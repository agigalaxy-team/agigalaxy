package native

import (
	"context"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"path/filepath"
	"strings"
	"testing"
)

func sharedSummaryFixture(room, grant, share string) map[string]any {
	return map[string]any{"shareId": share, "roomId": room, "expectedMemberRevision": 1, "audience": "room-authorized-members", "agentGrantId": grant, "content": map[string]any{"generator": map[string]any{"kind": "manual", "label": "fixture"}, "coverage": map[string]any{"fromSequence": "0", "throughSequence": "0", "complete": false}, "fragments": []any{map[string]any{"id": uuid.NewString(), "kind": "personal-note", "text": "Explicitly selected manual note", "sourceRefs": []any{}}}, "keyMessageRefs": []any{}}}
}
func TestRemoteSummaryInboxOriginalEightContractsAndRefinements(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	cases := []map[string]any{{"name": "galaxy_chat_shared_summary_publish", "input": sharedSummaryFixture(id, id, id)}, {"name": "galaxy_chat_shared_summary_get", "input": map[string]any{"roomId": id, "shareId": id}}, {"name": "galaxy_chat_shared_summary_receipt", "input": map[string]any{"roomId": id, "shareId": id, "requestHash": strings.Repeat("a", 64)}}, {"name": "galaxy_chat_shared_summary_list", "input": map[string]any{"roomId": id}}, {"name": "galaxy_chat_shared_summary_retract", "input": map[string]any{"roomId": id, "shareId": id}}, {"name": "galaxy_inbox_query", "input": map[string]any{"after": "room-message:" + id}}, {"name": "galaxy_inbox_options", "input": map[string]any{}}, {"name": "galaxy_inbox_options_save", "input": map[string]any{"expectedRevision": 0, "settings": map[string]any{"rooms": false}}}}
	path := filepath.Join(t.TempDir(), "contracts.json")
	if e := writeJSON(path, cases); e != nil {
		t.Fatal(e)
	}
	original := initializationNode(t, `import {readFile} from 'node:fs/promises';import {nativeHttpDefinitions} from './packages/galaxy-edge-mcp/src/native-v2/tools/http.mjs';const calls=[],api={call:(path,input)=>{calls.push({path,input});return{items:[]}}},tools=nativeHttpDefinitions(api),cases=JSON.parse(await readFile(process.argv[1],'utf8')),normalized=[];for(const x of cases){const value=tools[x.name].inputSchema.parse(x.input);normalized.push(value);await tools[x.name].run(value)}console.log(JSON.stringify({calls,normalized}));`, path)
	paths := map[string]string{"galaxy_chat_shared_summary_publish": "/v2/chat/shared-summaries/publish", "galaxy_chat_shared_summary_get": "/v2/chat/shared-summaries/get", "galaxy_chat_shared_summary_receipt": "/v2/chat/shared-summaries/receipt", "galaxy_chat_shared_summary_list": "/v2/chat/shared-summaries/list", "galaxy_chat_shared_summary_retract": "/v2/chat/shared-summaries/retract", "galaxy_inbox_query": "/v2/notifications/query", "galaxy_inbox_options": "/v2/notifications/options/read", "galaxy_inbox_options_save": "/v2/notifications/options/save"}
	for index, item := range cases {
		value, e := remoteSummaryNormalize(text(item["name"]), item["input"])
		expected := uploadObject(uploadRows(original["calls"])[index])
		if e != nil || !connectionEqual(value, uploadRows(original["normalized"])[index]) || expected["path"] != paths[text(item["name"])] || !connectionEqual(expected["input"], value) {
			t.Fatal("original summary/inbox differs", item["name"], value, e, expected)
		}
	}
	for _, change := range []func(map[string]any){func(c map[string]any) {
		coverage := uploadObject(c["coverage"])
		coverage["fromSequence"] = "9223372036854775809"
		coverage["throughSequence"] = "9223372036854775808"
	}, func(c map[string]any) { uploadObject(uploadRows(c["fragments"])[0])["kind"] = "derived" }, func(c map[string]any) { c["fragments"] = []any{} }, func(c map[string]any) {
		fragment := uploadObject(uploadRows(c["fragments"])[0])
		c["fragments"] = []any{fragment, identityClone(fragment)}
	}, func(c map[string]any) {
		fragments := []any{}
		for i := 0; i < 9; i++ {
			fragments = append(fragments, map[string]any{"id": uuid.NewString(), "kind": "personal-note", "text": strings.Repeat("x", 7900), "sourceRefs": []any{}})
		}
		c["fragments"] = fragments
	}} {
		input := sharedSummaryFixture(id, id, id)
		change(uploadObject(input["content"]))
		if _, e := remoteSummaryNormalize("galaxy_chat_shared_summary_publish", input); e == nil {
			t.Fatal("summary refinement ignored")
		}
	}
	if _, e := remoteSummaryNormalize("galaxy_inbox_query", map[string]any{"after": "room-message:00000000-0000-0000-8000-000000000001"}); e == nil {
		t.Fatal("invalid actual UUID passed inbox refinement")
	}
	store, e := NewStore(t.TempDir(), "https://summary.invalid")
	if e != nil {
		t.Fatal(e)
	}
	runtime := commandRuntime(t, store)
	server := mcp.NewServer(&mcp.Implementation{Name: "summaries", Version: "1"}, nil)
	tools := &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}
	registerRemoteSummaryTools(server, tools, runtime)
	registerRemoteInboxTools(server, tools, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(context.Background(), st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "summaries", Version: "1"}, nil)
	session, e := client.Connect(context.Background(), ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	registered, e := session.ListTools(context.Background(), nil)
	if e != nil || len(registered.Tools) != 8 {
		t.Fatal("incomplete summary/inbox domain", e)
	}
	materialCall(t, session, "galaxy_inbox_options_save", map[string]any{"expectedRevision": 0, "settings": map[string]any{}, "confirmed": true}, true)
}
