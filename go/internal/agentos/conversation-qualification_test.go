package agentos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestConversationReadQualificationCurrentIdentityWithoutSourceReads(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	f.Delegated(t)
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	id := current.Row.ID
	// The saved descriptor's old timestamp is never renewed as authority.
	ref := Object{"kind": "post", "id": uuid.NewString(), "version": 1, "controlledSource": true, "readExpiresAt": f.Now().Unix() - 100}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_sources_v1(conversation_id,source_key,evidence_ref,created_at) VALUES($1,$2,$3,$4)`, id, strings.Repeat("e", 64), ref, f.Now()); err != nil {
		t.Fatal(err)
	}
	sourceCalls := 0
	s.ValidateSources = func(context.Context, Conversation, operationspermissions.Actor) (SourceQualification, error) {
		sourceCalls++
		return SourceQualification{}, fail("synthetic_source_unavailable", 503)
	}
	s.ToolCards = func(context.Context, operationspermissions.Actor, string) ([]Object, error) {
		t.Fatal("qualification must not prepare or recover cards")
		return nil, nil
	}
	s.SyncWorkbenchRuns = func(context.Context, Conversation, []Object) error {
		t.Fatal("qualification must not update workbench facts")
		return nil
	}
	call := func(path string) (*httptest.ResponseRecorder, Object) {
		t.Helper()
		r := httptest.NewRequest("GET", "https://admin.example.invalid"+path, nil)
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		w := httptest.NewRecorder()
		ConversationHandler{Service: s, Authority: f.Gateway}.ServeHTTP(w, r)
		var value Object
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatal(err, w.Body.String())
		}
		return w, value
	}
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Error("context called a native record")
			http.Error(w, "unexpected", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "model": "configured", "conversations": Object{"version": 2, "agentIds": []string{"galaxy-conversation-overview"}}})
	}))
	defer health.Close()
	s.Client, err = New(Configuration{URL: health.URL, SigningKey: strings.Repeat("s", 32)}, Options{Now: f.Now})
	if err != nil {
		t.Fatal(err)
	}
	contextView, err := s.ReadContext(ctx, f.Root, "overview")
	if err != nil || contextView["conversationId"] != id || sourceCalls != 0 {
		t.Fatal("context read consulted old sources", contextView, sourceCalls, err)
	}
	path := "/v1/operations/agentos/conversations/overview/qualification"
	w, value := call(path)
	if w.Code != 200 || value["kind"] != "conversation-read-qualification" || value["metadataOnly"] != true || value["conversationId"] != id || value["contextChanged"] != false || value["readExpiresAt"] != float64(f.Now().Unix()+30) {
		t.Fatal("qualification omitted current reader deadline", w.Code, value)
	}
	for _, key := range []string{"runs", "toolCards", "unchanged"} {
		if _, exists := value[key]; exists {
			t.Fatal("qualification claimed body freshness or included native data", key)
		}
	}
	if sourceCalls != 0 {
		t.Fatal("qualification queried retained sources", sourceCalls)
	}
	var retired *time.Time
	if err = owner.QueryRow(ctx, `SELECT retired_at FROM operations_agentos_conversations_v1 WHERE id=$1`, id).Scan(&retired); err != nil || retired != nil {
		t.Fatal("reading retired conversation", retired, err)
	}
	before, err := s.readSession(ctx, f.Root, "overview")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_conversations_v1 SET retired_at=$2 WHERE id=$1`, id, f.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = s.finishConversationRead(ctx, f.Root, "overview", before); err == nil {
		t.Fatal("changed conversation accepted")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_conversations_v1 SET retired_at=NULL WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	w, _ = call(path)
	if w.Code != 403 {
		t.Fatal("fixed AI revocation was hidden", w.Code, w.Body.String())
	}
}

func TestConversationCardUnchangedReceiptReadDoesNotEmitEvent(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	f.Delegated(t)
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	turn, callID, cardID, operation := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	before := f.Now().Add(-time.Minute)
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted','{}',$6)`, turn, f.Endpoint, current.Row.ID, f.Root.ID, strings.Repeat("d", 64), before); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,'synthetic-owned-run','same-result','prepare-operation',$5,'completed','{}',$6,$6)`, callID, f.Endpoint, current.Row.ID, turn, strings.Repeat("e", 64), before); err != nil {
		t.Fatal(err)
	}
	proposal := Object{"kind": "file-scan-retry", "domain": "overview", "target": Object{"id": uuid.NewString()}, "impact": []any{}, "basis": []any{}}
	receipt := Object{"operationId": operation, "state": "unknown", "summary": "Original receipt is still unknown.", "confirmationAttemptedAt": "original-attempt"}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,$8,$9,'unknown',$10,$11,$11)`, cardID, f.Endpoint, current.Row.ID, turn, callID, f.Root.ID, operation, strings.Repeat("f", 64), proposal, receipt, before); err != nil {
		t.Fatal(err)
	}
	tools := &ConversationTools{Conversations: s, CardReadPermission: func(string) (string, error) { return "ai.roles.read", nil }, RecoverPrepared: func(context.Context, operationspermissions.Actor, Object, string) (Object, error) {
		return copyObject(receipt), nil
	}}
	events := func() int {
		t.Helper()
		var count int
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM web_event_outbox_v1 WHERE source_table='operations_agentos_conversation_cards_v1' AND source_ref->>'id'=$1`, cardID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	baseline := events()
	for range 2 {
		if _, err = tools.Card(ctx, f.Root, "overview", cardID); err != nil {
			t.Fatal(err)
		}
	}
	var updated time.Time
	if err = owner.QueryRow(ctx, `SELECT updated_at FROM operations_agentos_conversation_cards_v1 WHERE id=$1`, cardID).Scan(&updated); err != nil || !updated.Equal(before) || events() != baseline {
		t.Fatal("unchanged read produced a timestamp/event mutation", updated, before, events(), baseline, err)
	}
	receipt["state"], receipt["summary"] = "completed", "Original durable receipt completed."
	card, err := tools.Card(ctx, f.Root, "overview", cardID)
	if err != nil || card["state"] != "completed" || events() != baseline+1 {
		t.Fatal("real receipt transition did not remain observable", card, events(), baseline, err)
	}
}
