package native

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	path := filepath.Join(t.TempDir(), "cases.json")
	if e := writeJSON(path, cases); e != nil {
		t.Fatal(e)
	}
	original := initializationNode(t, `import {readFile} from 'node:fs/promises';import {chatToolDefinitions} from './packages/galaxy-official/src/adapters/mcp/personal/tools/chat-v2.mjs';const tools=chatToolDefinitions({chat:{}},null),cases=JSON.parse(await readFile(process.argv[1],'utf8'));console.log(JSON.stringify({items:cases.map(x=>{const parsed=tools[x.name].inputSchema.safeParse(x.input);return parsed.success?{ok:true,value:parsed.data}:{ok:false}})}));`, path)
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
	if e != nil || len(tools.Tools) != 22 {
		t.Fatal("incomplete chat tools", e)
	}
	materialCall(t, cs, "galaxy_chat_send", map[string]any{"roomId": id, "agentGrantId": id, "clientMessageId": id, "text": "okay", "confirmed": true}, true)
	if _, e = os.Stat(filepath.Join(store.Directory, "native-v2")); !os.IsNotExist(e) {
		t.Fatal("invalid schema created identity")
	}
}
