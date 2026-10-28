package native

import (
	"path/filepath"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func TestA2aOriginalSDKProjectionAndPeerOnlyArtifacts(t *testing.T) {
	cases := []any{
		map[string]any{"id": "peer-task", "context_id": "peer-context", "status": map[string]any{"state": 3, "message": map[string]any{"message_id": "m", "role": 2, "parts": []any{map[string]any{"text": "selected 回答", "media_type": "text/plain"}}}}, "artifacts": []any{map[string]any{"artifact_id": "a", "name": "artifact", "parts": []any{map[string]any{"raw": "YWJjZA", "media_type": "application/octet-stream"}, map[string]any{"url": "https://never-fetched.invalid/result?private=1", "mediaType": "text/plain"}, map[string]any{"data": map[string]any{"z": 1, "a": true}, "metadata": map[string]any{"selected": true}}}}}, "metadata": map[string]any{"extra": "retained"}, "history": []any{map[string]any{"messageId": "m", "role": "ROLE_USER", "parts": []any{map[string]any{"text": "request"}}, "extensions": []any{"selected-extension"}, "reference_task_ids": []any{"other-task"}}}, "ignored": "not hashed by SDK"},
		map[string]any{"message_id": "standalone", "context_id": "context", "role": "ROLE_AGENT", "parts": []any{map[string]any{"text": "reply"}}},
	}
	file := filepath.Join(t.TempDir(), "peer-projections.json")
	if e := writeJSON(file, cases); e != nil {
		t.Fatal(e)
	}
	original := initializationNode(t, `import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import {snapshot} from './packages/galaxy-a2a/src/facts/mapping.mjs';const require=createRequire(new URL('./packages/galaxy-a2a/package.json',import.meta.url)),{Task,Message}=require('@a2a-js/sdk'),cases=JSON.parse(await readFile(process.argv[1],'utf8'));console.log(JSON.stringify({snapshots:cases.map(v=>snapshot(Object.hasOwn(v,'id')?Task.fromJSON(v):Message.fromJSON(v)))}));`, file)
	raw, _ := protocol.Encode(cases)
	decoded, e := protocol.DecodeOrdered(raw)
	if e != nil {
		t.Fatal(e)
	}
	for i, item := range decoded.([]any) {
		got, e := a2aSnapshot(item, nil)
		if e != nil || !connectionEqual(got, uploadRows(original["snapshots"])[i]) {
			t.Fatal("original SDK snapshot differs", i, got, e, uploadRows(original["snapshots"])[i])
		}
	}
	first := decoded.([]any)[0]
	if _, e = a2aSnapshot(first, map[string]any{"contextId": "another"}); e == nil {
		t.Fatal("peer context replacement accepted")
	}
	if _, e = a2aSnapshot(first, map[string]any{"taskId": "peer-task", "contextId": "peer-context", "state": "failed"}); e == nil {
		t.Fatal("terminal peer state changed")
	}
}
