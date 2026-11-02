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
	first, second := uuid.NewString(), uuid.NewString()
	ref := Object{"kind": "message-plan", "id": uuid.NewString(), "version": 1, "controlledSource": true}
	if err = tools.rememberSources(ctx, *current.Row, first, []any{ref}); err != nil {
		t.Fatal(err)
	}
	if err = tools.rememberSources(ctx, *current.Row, first, []any{ref}); err != nil {
		t.Fatal(err)
	}
	changed := copyObject(ref)
	changed["version"] = 2
	if err = tools.rememberSources(ctx, *current.Row, second, []any{changed}); err != nil {
		t.Fatal(err)
	}
	if err = tools.rememberSources(ctx, *current.Row, second, []any{Object{"kind": "message-plan", "id": uuid.NewString(), "controlledSource": true}}); fault.Code(err) != "operations_agentos_source_qualification_unavailable" {
		t.Fatal(err)
	}
	var count int
	if err = owner.QueryRow(ctx, `SELECT count(*) FROM operations_agentos_conversation_sources_v1 WHERE conversation_id=$1`, current.Row.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("saved %d: %v", count, err)
	}
	s.ValidateSources = s.SourceValidator(func(_ context.Context, _ operationspermissions.Actor, _ string, refs []Object) (Object, error) {
		valid, invalid := []any{}, []any{}
		for i, v := range refs {
			if sameConversationJSON(v["version"], 1) {
				invalid = append(invalid, i)
			} else {
				valid = append(valid, Object{"readExpiresAt": f.Now().Unix() + 20})
			}
		}
		return Object{"valid": false, "refs": valid, "invalidIndexes": invalid}, nil
	})
	qualified, err := s.CurrentRead(ctx, current.Row.ID, nil)
	if err != nil || !qualified.SourceQualification.AffectedTurns[first] || qualified.SourceQualification.AffectedTurns[second] || qualified.Row.ID != current.Row.ID {
		t.Fatalf("qualification: %#v %v", qualified.SourceQualification, err)
	}
}

func TestQualificationRestrictsOnlyAffectedOrUnassociatedLegacyTurns(t *testing.T) {
	q := SourceQualification{AffectedTurns: map[string]bool{"changed": true}, LegacyUnknown: true, LegacySafeTurns: map[string]bool{"new": true, "changed": true}}
	for turn, want := range map[string]bool{"old": true, "changed": true, "new": false} {
		if q.restricts(turn) != want {
			t.Fatalf("turn %s expected restricted %v", turn, want)
		}
	}
}

func TestSourceQualificationBatchesPastQueryLimit(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_sources_v1(conversation_id,source_key,evidence_ref,created_at) SELECT $1,md5(i::text),jsonb_build_object('kind','post','id',i,'version',1,'conversationTurnId',$2::text),now() FROM generate_series(1,301) i`, current.Row.ID, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	validator := s.SourceValidator(func(_ context.Context, _ operationspermissions.Actor, _ string, refs []Object) (Object, error) {
		calls++
		if len(refs) > 300 {
			t.Fatal("exceeded revalidation batch")
		}
		valid := make([]any, len(refs))
		for i := range valid {
			valid[i] = Object{"readExpiresAt": f.Now().Unix() + 20}
		}
		return Object{"valid": true, "refs": valid, "invalidIndexes": []any{}}, nil
	})
	result, err := validator(ctx, *current.Row, current.Actor)
	if err != nil || !result.Valid || calls != 2 {
		t.Fatalf("batches=%d result=%#v err=%v", calls, result, err)
	}
}
