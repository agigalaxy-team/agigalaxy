package agentos

import "testing"

func TestTaskDispatchGoalIsTextRatherThanInternalCommand(t *testing.T) {
	p := Object{"kind": "task-dispatch", "title": "Compare current needs", "target": Object{"label": "数据与发现"}, "request": Object{"goal": "Read reports mentioning {theme: accessibility}; compare actual changes."}, "impact": []any{"执行安排：每 37 分钟", "首次执行：确认后开始"}}
	view := cardPresentation(p)
	if view["reviewable"] != true {
		t.Fatalf("ordinary user goal should remain reviewable: %#v", view)
	}
	if len(view["details"].([]any)) < 3 {
		t.Fatal("dispatch details missing")
	}
}

func TestReceiptReferencesPreserveGenericObjectIdentityOnly(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	refs := resultReferences([]any{Object{"kind": "future-business-object", "id": id}, Object{"kind": "task-assignment", "id": id, "command": "not-a-reference"}, Object{"kind": "bad", "id": "https://example.invalid"}})
	if len(refs) != 1 || refs[0]["kind"] != "future-business-object" || refs[0]["id"] != id {
		t.Fatalf("receipt references %#v", refs)
	}
}
