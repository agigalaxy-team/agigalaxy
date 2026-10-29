package agentos

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestConversationCanonicalJSONValues(t *testing.T) {
	cases := []struct {
		a, b any
		same bool
	}{
		{`[1,1,"draft"]`, `[1,1,"draft"]`, true}, {float64(1), 1, true}, {true, true, true}, {nil, nil, true},
		{Object{"x": []any{1, "a"}}, Object{"x": []any{float64(1), "a"}}, true},
		{`[1,1,"draft"]`, `[2,1,"draft"]`, false}, {1, 2, false},
	}
	for _, c := range cases {
		if sameConversationJSON(c.a, c.b) != c.same {
			t.Errorf("comparison: %#v %#v expected %v", c.a, c.b, c.same)
		}
	}
}

func TestConversationRememberSourcesVersionsAndRecheckPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	f.Delegated(t)
	ctx := context.Background()
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	tools := &ConversationTools{Conversations: s}
	message := Object{"kind": "message-plan", "id": uuid.NewString(), "version": `[1,1,"draft"]`, "controlledSource": true}
	feedback := Object{"kind": "feedback", "id": uuid.NewString(), "version": 1, "controlledSource": true}
	refs := []any{message, feedback}
	if err = tools.rememberSources(ctx, *current.Row, refs); err != nil {
		t.Fatal(err)
	}
	if err = tools.rememberSources(ctx, *current.Row, refs); err != nil {
		t.Fatal(err)
	}
	changed := copyObject(message)
	changed["version"] = `[2,1,"draft"]`
	if err = tools.rememberSources(ctx, *current.Row, []any{changed}); fault.Code(err) != "operations_agentos_source_changed" {
		t.Fatalf("changed version: %v", err)
	}
	missing := Object{"kind": "message-plan", "id": uuid.NewString(), "controlledSource": true}
	if err = tools.rememberSources(ctx, *current.Row, []any{missing}); fault.Code(err) != "operations_agentos_source_qualification_unavailable" {
		t.Fatalf("missing version: %v", err)
	}
	var count int
	if err = owner.QueryRow(ctx, `SELECT count(*) FROM operations_agentos_conversation_sources_v1 WHERE conversation_id=$1`, current.Row.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("saved sources %d: %v", count, err)
	}
	legacy := Object{"kind": "message-plan", "id": uuid.NewString(), "controlledSource": true}
	if err = tools.rememberSources(ctx, *current.Row, []any{Object{"kind": "message-plan", "id": legacy["id"], "version": 1, "controlledSource": true}}); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_sources_v1 SET evidence_ref=evidence_ref - 'version' WHERE conversation_id=$1 AND evidence_ref->>'id'=$2`, current.Row.ID, legacy["id"]); err != nil {
		t.Fatal(err)
	}
	legacy["version"] = 1
	if err = tools.rememberSources(ctx, *current.Row, []any{legacy}); fault.Code(err) != "operations_agentos_source_qualification_unavailable" {
		t.Fatalf("legacy missing version: %v", err)
	}
	// Qualification still depends on current source authorization, independent of matching versions.
	s.ValidateSources = s.SourceValidator(func(_ context.Context, _ operationspermissions.Actor, _ string, _ []Object) (Object, error) {
		return Object{"valid": false, "refs": []any{}}, nil
	})
	if _, err = s.CurrentRead(ctx, current.Row.ID, nil); fault.Code(err) != "operations_agentos_source_changed" {
		t.Fatalf("revoked source must fail: %v", err)
	}
}
