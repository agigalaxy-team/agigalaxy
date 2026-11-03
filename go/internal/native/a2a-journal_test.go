package native

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestA2aJournalRoundTripReservationAndCAS(t *testing.T) {
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
	id := "00000000-0000-4000-8000-000000000001"
	_, e = j.change(ctx, id, 0, nil, func(map[string]any) (map[string]any, error) {
		return map[string]any{"id": id, "caseId": "case", "attemptId": "attempt", "status": "dispatching", "operations": []any{map[string]any{"id": "original-op", "requestHash": "original-hash", "outcome": "dispatching"}}}, nil
	})
	if e != nil {
		t.Fatal(e)
	}
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
	reopened, e := newA2aJournal(s, scope)
	if e != nil || reopened.scopeHash != j.scopeHash {
		t.Fatal("journal scope changed on reopen", e)
	}
	again, e := reopened.list(ctx)
	if e != nil || len(again) != 1 {
		t.Fatal("journal could not be read after reopen", e)
	}
	row := uploadObject(again[0])
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

func TestA2aCurrentFactsAndScopeWithdrawal(t *testing.T) {
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
	want := map[string]any{"version": 2, "attemptRef": map[string]any{"id": attemptID, "version": 1}, "origin": map[string]any{"kind": "attempt", "id": attemptID, "version": 1}, "taskId": taskID, "participationId": "p", "scopeVersion": 2, "participationScopeVersion": 4}
	if !connectionEqual(facts, want) {
		t.Fatal("resolved facts do not match the selected Attempt and Task", facts)
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
