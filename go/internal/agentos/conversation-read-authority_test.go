package agentos

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type conversationStoredReadCounter struct {
	operationspermissions.StoredPersonAuthority
	reads int
}

func (a *conversationStoredReadCounter) PersonWithin(ctx context.Context, tx pgx.Tx, id string, eligible bool) (operationspermissions.Actor, error) {
	a.reads++
	return a.StoredPersonAuthority.PersonWithin(ctx, tx, id, eligible)
}

func TestConversationCurrentReadPreservesFixedIdentityAndSourceQualification(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	initial, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	id := initial.Row.ID
	counter := &conversationStoredReadCounter{StoredPersonAuthority: f.Permissions.StoredAuthority}
	f.Permissions.StoredAuthority = counter
	deadline := f.Now().Unix() + 7
	s.ValidateSources = func(_ context.Context, row Conversation, a operationspermissions.Actor) (SourceQualification, error) {
		if row.ID != id || a.ID != f.Root.ID || a.AIProof == nil {
			t.Fatal("source check lost the original fixed identity")
		}
		return SourceQualification{Valid: true, ReadExpiresAt: deadline}, nil
	}
	legacy, err := s.Current(ctx, id, nil)
	if err != nil || counter.reads != 4 {
		t.Fatal("original write-capable fence changed", counter.reads, err)
	}
	counter.reads = 0
	read, err := s.CurrentRead(ctx, id, nil)
	if err != nil || counter.reads != 1 {
		t.Fatal("stored read repeated the person projection", counter.reads, err)
	}
	if read.Actor.Version != legacy.Actor.Version || permissionKey(read.Actor) != legacy.Row.PermissionKey || read.ReadExpiresAt != deadline || *read.Row.AIAccountID != *legacy.Row.AIAccountID {
		t.Fatal("read snapshot changed identity, permissions or source qualification")
	}
	human, err := s.CurrentRead(ctx, id, &f.Root)
	if err != nil || permissionKey(human.Actor) != legacy.Row.PermissionKey {
		t.Fatal("cookie reader changed fixed scope", err)
	}
	forged := operationspermissions.Actor{ID: f.Root.ID, Endpoint: f.Endpoint}
	if _, err = s.CurrentRead(ctx, id, &forged); fault.Status(err) != 403 {
		t.Fatal("forged read identity accepted", err)
	}
	foreign := f.Root
	foreign.ID = f.IDs["writer"]
	if _, err = s.CurrentRead(ctx, id, &foreign); fault.Status(err) != 404 {
		t.Fatal("another owner read the conversation", err)
	}
	if _, err = owner.Exec(ctx, "UPDATE operations_agentos_conversations_v1 SET permission_key=$2 WHERE id=$1", id, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CurrentRead(ctx, id, nil); fault.Code(err) != "operations_agentos_authority_changed" {
		t.Fatal("changed permission key was accepted", err)
	}
	if _, err = owner.Exec(ctx, "UPDATE operations_agentos_conversations_v1 SET permission_key=$2 WHERE id=$1", id, legacy.Row.PermissionKey); err != nil {
		t.Fatal(err)
	}
	deadline = f.Now().Unix()
	if _, err = s.CurrentRead(ctx, id, nil); fault.Code(err) != "operations_agentos_source_qualification_unavailable" {
		t.Fatal("source expiry was extended", err)
	}
	deadline = f.Now().Unix() + 7
	if _, err = owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='overview'", f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CurrentRead(ctx, id, &read.Actor); fault.Status(err) != 403 {
		t.Fatal("old snapshot survived fixed-AI revocation", err)
	}
}

func TestConversationReadToolSnapshotsKeepFinalRevocationAndWriteFences(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	turn := uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted','owned-read-run','{}',$6)`, turn, f.Endpoint, current.Row.ID, f.Root.ID, strings.Repeat("d", 64), f.Now()); err != nil {
		t.Fatal(err)
	}
	counter := &conversationStoredReadCounter{StoredPersonAuthority: f.Permissions.StoredAuthority}
	f.Permissions.StoredAuthority = counter
	validSource, sourceChecks := true, 0
	s.ValidateSources = func(context.Context, Conversation, operationspermissions.Actor) (SourceQualification, error) {
		sourceChecks++
		return SourceQualification{Valid: validSource, ReadExpiresAt: f.Now().Unix() + 9}, nil
	}
	tools := &ConversationTools{Conversations: s}
	s.Tools = tools
	input := Object{"conversationId": current.Row.ID, "sessionId": current.Row.SessionID, "turnId": turn, "runId": "owned-read-run", "arguments": Object{}}
	for _, tool := range []string{"workbench-summary", "query-operations", "read-operation-object", "read-ai-delegation", "list-authorized-work", "prepare-operation", "run-authorized-work"} {
		input["tool"], input["callId"] = tool, uuid.NewString()
		counter.reads = 0
		if _, err = tools.bind(ctx, input); err != nil {
			t.Fatal(tool, err)
		}
		want := 2
		if tool == "prepare-operation" || tool == "run-authorized-work" {
			want = 8
		}
		if counter.reads != want {
			t.Fatal("tool changed its read/write authority boundary", tool, counter.reads, want)
		}
	}
	counter.reads = 0
	if err = tools.RecheckContext(ctx, current.Actor, "overview", Object{"conversationId": current.Row.ID, "turnId": turn}); err != nil || counter.reads != 0 {
		t.Fatal("summary cookie-scope recheck failed", counter.reads, err)
	}
	mode := ""
	tools.Query = func(context.Context, operationspermissions.Actor, string, string, Object) (Object, error) {
		if mode == "ai" {
			if _, e := owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='overview'", f.Endpoint); e != nil {
				return nil, e
			}
		} else if mode == "source" {
			validSource = false
		}
		return Object{"tool": "query-operations", "data": "CURRENT_READ_MUST_NOT_LEAK_AFTER_REVOCATION", "evidenceRefs": []any{}}, nil
	}
	client, err := New(Configuration{ServiceKey: strings.Repeat("k", 32)}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, attempt := range []struct {
		mode   string
		status int
	}{{"", 200}, {"ai", 403}, {"source", 409}} {
		mode = attempt.mode
		counter.reads, sourceChecks = 0, 0
		input["tool"], input["callId"] = "query-operations", uuid.NewString()
		body, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/v1/internal/agentos/tools/execute", bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("k", 32))
		w := httptest.NewRecorder()
		NativeHandler{Client: client, Conversations: s}.ServeHTTP(w, r)
		if w.Code != attempt.status {
			t.Fatal(mode, w.Code, w.Body.String())
		}
		if counter.reads != 3 {
			t.Fatal("tool skipped its independent final person check", mode, counter.reads)
		}
		if attempt.status == 200 && sourceChecks != 2 {
			t.Fatal("tool skipped its independent final source check", sourceChecks)
		}
		if attempt.status != 200 && strings.Contains(w.Body.String(), "CURRENT_READ_MUST_NOT_LEAK_AFTER_REVOCATION") {
			t.Fatal("final fence released revoked material")
		}
		if mode == "ai" {
			if _, err = owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'", f.Endpoint); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestConversationTaskOperationBindsOriginalRunAndArguments(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	turn := uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted','task-read-run','{}',$6)`, turn, f.Endpoint, current.Row.ID, f.Root.ID, strings.Repeat("d", 64), f.Now()); err != nil {
		t.Fatal(err)
	}
	task, operation := uuid.NewString(), uuid.NewString()
	called := 0
	tools := &ConversationTools{Conversations: s, ReadTaskOperation: func(_ context.Context, _ operationspermissions.Actor, row Conversation, args Object) (Object, error) {
		called++
		if row.ID != current.Row.ID || args["taskId"] != task || args["operationId"] != operation {
			t.Fatal("wrong original coordinates")
		}
		return Object{"availability": "available", "receipt": Object{"state": "unknown"}, "evidenceRefs": []any{}}, nil
	}}
	input := Object{"conversationId": current.Row.ID, "sessionId": current.Row.SessionID, "turnId": turn, "runId": "task-read-run", "callId": "receipt-1", "tool": "read-task-operation", "arguments": Object{"taskId": task, "operationId": operation}}
	result, err := tools.Execute(ctx, input)
	if err != nil || object(result["receipt"])["state"] != "unknown" || called != 1 {
		t.Fatalf("original read %#v %v", result, err)
	}
	input["arguments"] = Object{"taskId": task, "operationId": uuid.NewString()}
	if _, err = tools.Execute(ctx, input); fault.Status(err) != 409 || called != 1 {
		t.Fatalf("changed call binding accepted: %v", err)
	}
}
