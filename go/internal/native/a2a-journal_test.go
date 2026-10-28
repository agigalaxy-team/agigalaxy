package native

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func TestA2aOriginalJournalRoundTripReservationAndCAS(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "private")
	s, _ := NewStore(dir, "https://official.invalid")
	scope := a2aJournalScope{"GUID0123456789ABCDEFGHIJKLMNOPQR", "https://official.invalid", "https://peer.invalid/a2a", "selected tenant", "peer one"}
	j, e := newA2aJournal(s, scope)
	if e != nil {
		t.Fatal(e)
	}
	links, e := j.list(ctx)
	if e != nil || len(links) != 0 {
		t.Fatal(links, e)
	}
	if _, e = os.Stat(dir); !os.IsNotExist(e) {
		t.Fatal("read created directory", e)
	}
	input := filepath.Join(t.TempDir(), "scope.json")
	if e = writeJSON(input, scope); e != nil {
		t.Fatal(e)
	}
	original := initializationNode(t, `import {readFile} from 'node:fs/promises';import {createJournal} from './packages/galaxy-a2a/src/storage/journal.mjs';const scope=JSON.parse(await readFile(process.argv[2],'utf8')),j=createJournal(process.argv[1],scope);await j.change('00000000-0000-4000-8000-000000000001',0,()=>({id:'00000000-0000-4000-8000-000000000001',caseId:'case',attemptId:'attempt',status:'dispatching',operations:[{id:'original-op',requestHash:'original-hash',outcome:'dispatching'}]}));console.log(JSON.stringify({scopeHash:j.scopeHash,links:await j.list()}));`, dir, input)
	if original["scopeHash"] != j.scopeHash {
		t.Fatal("JSON.stringify scope hash differs", j.scopeHash, original)
	}
	id := "00000000-0000-4000-8000-000000000001"
	link, e := j.get(ctx, id)
	if e != nil || link["status"] != "dispatching" {
		t.Fatal(link, e)
	}
	_, e = j.change(ctx, id, 0, nil, func(p map[string]any) (map[string]any, error) { p["status"] = "observed"; return p, nil })
	if e == nil {
		t.Fatal("stale write accepted")
	}
	_, e = j.change(ctx, id, 1, nil, func(p map[string]any) (map[string]any, error) { p["status"] = "unknown"; return p, nil })
	if e != nil {
		t.Fatal(e)
	}
	again := initializationNode(t, `import {readFile} from 'node:fs/promises';import {createJournal} from './packages/galaxy-a2a/src/storage/journal.mjs';const j=createJournal(process.argv[1],JSON.parse(await readFile(process.argv[2],'utf8')));console.log(JSON.stringify({links:await j.list()}));`, dir, input)
	row := uploadObject(uploadRows(again["links"])[0])
	if row["status"] != "unknown" || integer(row["revision"]) != 2 || text(uploadObject(uploadRows(row["operations"])[0])["requestHash"]) != "original-hash" {
		t.Fatal("original reservation lost", again)
	}
	_, e = j.change(ctx, "another", 0, nil, func(map[string]any) (map[string]any, error) {
		return map[string]any{"id": "another", "caseId": "case", "attemptId": "attempt"}, nil
	})
	if e == nil {
		t.Fatal("same Attempt dispatched twice")
	}
	otherScope := scope
	otherScope.PeerPrincipal = "another principal"
	other, _ := newA2aJournal(s, otherScope)
	if rows, e := other.list(ctx); e != nil || len(rows) != 0 {
		t.Fatal("peer principal isolation lost", e)
	}
	raw, e := os.ReadFile(filepath.Join(dir, "a2a-"+j.scopeHash+".json"))
	if e != nil {
		t.Fatal(e)
	}
	_, e = j.change(ctx, id, 2, func(string) error { return a2aError("identity changed") }, func(p map[string]any) (map[string]any, error) { p["status"] = "observed"; return p, nil })
	if e == nil {
		t.Fatal("identity guard ignored")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "a2a-"+j.scopeHash+".json"))
	if string(raw) != string(after) {
		t.Fatal("denied mutation changed original journal")
	}
}

func TestA2aCurrentFactsMatchOriginalAndRejectScopeWithdrawal(t *testing.T) {
	ctx := context.Background()
	subject := "GUID0123456789ABCDEFGHIJKLMNOPQR"
	caseID := "00000000-0000-4000-8000-000000000001"
	attemptID := "00000000-0000-4000-8000-000000000002"
	taskID := "00000000-0000-4000-8000-000000000003"
	current := map[string]any{"caseId": caseID, "version": 3, "scopeVersion": 2, "attempts": []any{map[string]any{"id": attemptID, "version": 1, "actorId": subject, "provenance": "native-v2", "scopeVersion": 2, "taskId": taskID, "participationId": "p", "participationScopeVersion": 4}}}
	task := map[string]any{"taskId": taskID, "caseId": caseID, "paused": false, "state": "active", "participations": []any{map[string]any{"participationId": "p", "subjectId": subject, "scopeVersion": 4, "scopeAvailable": true, "state": "active"}}}
	selected := map[string]any{"attemptVersion": 1, "taskId": taskID}
	reader := a2aFactReaders{func(context.Context, string, map[string]any) (map[string]any, error) { return current, nil }, func(context.Context, string) (map[string]any, error) { return task, nil }}
	_, facts, e := reader.resolve(ctx, caseID, attemptID, subject, selected, nil)
	if e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(t.TempDir(), "facts.json")
	if e = writeJSON(file, map[string]any{"current": current, "task": task, "selected": selected, "caseId": caseID, "attemptId": attemptID, "subjectId": subject}); e != nil {
		t.Fatal(e)
	}
	original := initializationNode(t, `import {readFile} from 'node:fs/promises';import {createA2aFactsV2} from './packages/galaxy-a2a/src/facts/facts-v2.mjs';const x=JSON.parse(await readFile(process.argv[1],'utf8'));const r=await createA2aFactsV2({readCase:async()=>x.current,readTask:async()=>x.task}).resolve(x);console.log(JSON.stringify(r));`, file)
	if !connectionEqual(facts, original["factContext"]) {
		a, _ := protocol.Encode(facts)
		t.Fatal(string(a), original)
	}
	if _, _, e = reader.resolve(ctx, caseID, attemptID, subject, nil, facts); e != nil {
		t.Fatal("frozen source rejected", e)
	}
	current["scopeVersion"] = 3
	if _, _, e = reader.resolve(ctx, caseID, attemptID, subject, nil, facts); e == nil {
		t.Fatal("changed source scope accepted")
	}
	current["scopeVersion"] = 2
	for _, state := range []string{"canceled", "closed"} {
		task["state"] = state
		if _, _, e = reader.resolve(ctx, caseID, attemptID, subject, nil, facts); e == nil {
			t.Fatal("withdrawn Task accepted", state)
		}
	}
	task["state"] = "active"
	participation := uploadObject(uploadRows(task["participations"])[0])
	participation["scopeAvailable"] = false
	if _, _, e = reader.resolve(ctx, caseID, attemptID, subject, nil, facts); e == nil {
		t.Fatal("revoked Participation accepted")
	}
}
