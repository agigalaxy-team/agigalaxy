package native

import (
	"context"
	"strings"
	"testing"
)

func TestA2aMessageExchangeRetainsWholeOutputAndTaskContinuity(t *testing.T) {
	body := strings.Repeat("实际建议", 800)
	first, e := a2aSnapshot(map[string]any{"messageId": "first", "role": "ROLE_AGENT", "parts": []any{map[string]any{"text": body}}}, nil)
	if e != nil || first["state"] != "message-only" || first["goalCompletion"] != "unconfirmed" || text(a2aObject(uploadRows(a2aObject(first["output"])["parts"])[0])["text"]) != body {
		t.Fatal("simple response required a Task/context or lost usable output", first, e)
	}
	previous := map[string]any{"taskId": "real-task", "contextId": "real-context", "state": "working"}
	next, e := a2aSnapshot(map[string]any{"messageId": "reply", "role": "ROLE_AGENT", "taskId": "real-task", "contextId": "real-context", "parts": []any{map[string]any{"text": "需要补充信息"}}}, previous)
	if e != nil || next["taskId"] != "real-task" || next["state"] != "working" || next["goalCompletion"] != "unconfirmed" {
		t.Fatal("Message response finished or replaced the original active Task", next, e)
	}
	if _, e = a2aSnapshot(map[string]any{"messageId": "wrong", "taskId": "another-task", "contextId": "real-context"}, previous); e == nil {
		t.Fatal("peer response replaced the real Task")
	}
}

func TestA2aIndependentLocalExchangesDoNotCollideAsNilAttempts(t *testing.T) {
	ctx := context.Background()
	store, _ := NewStore(t.TempDir(), "https://official.invalid")
	j, e := newA2aJournal(store, a2aJournalScope{"owner", store.Endpoint, "https://peer.invalid/a2a", "", "peer"})
	if e != nil {
		t.Fatal(e)
	}
	for _, id := range []string{"one", "two"} {
		if _, e = j.change(ctx, id, 0, nil, func(map[string]any) (map[string]any, error) {
			return map[string]any{"id": id, "source": map[string]any{"kind": "local-work", "workId": "actual-work"}, "operations": []any{}}, nil
		}); e != nil {
			t.Fatal("independent simple exchanges were treated as the same formal Attempt", e)
		}
	}
	for _, kind := range []string{"local-work", "task"} {
		source := map[string]any{"kind": kind, "workId": "00000000-0000-4000-8000-000000000001"}
		if kind == "task" {
			delete(source, "workId")
			source["taskId"] = "00000000-0000-4000-8000-000000000001"
		}
		if _, e = a2aNormalize("galaxy_a2a_prepare", map[string]any{"peerId": "peer", "action": "send", "source": source, "text": "selected text"}); e != nil {
			t.Fatal("real-work source cannot use the original prepare route", kind, e)
		}
	}
}
