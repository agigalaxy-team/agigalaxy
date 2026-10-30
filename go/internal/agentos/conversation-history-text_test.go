package agentos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestConversationHistoryPureTextBatchAndIsolation(t *testing.T) {
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
	row := *current.Row
	root := uuid.NewString()
	for i := 0; i < 52; i++ {
		id := uuid.NewString()
		if i == 0 {
			id = root
		}
		result := Object{"runId": id}
		var native any = id
		if i > 0 {
			result["parentOperationId"], result["origin"] = root, "operation-feedback"
		}
		if i == 51 {
			native = nil
			result["runId"] = nil
		}
		_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8)`, id, f.Endpoint, row.ID, row.OperatorID, strings.Repeat("a", 64), native, result, f.Now().Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
	}
	var calls, sourceChecks, runSyncs atomic.Int32
	var mode atomic.Int32
	s.ValidateSources = func(context.Context, Conversation, operationspermissions.Actor) (SourceQualification, error) {
		sourceChecks.Add(1)
		return SourceQualification{}, fail("synthetic_source_unavailable", 503)
	}
	s.SyncWorkbenchRuns = func(context.Context, Conversation, []Object) error { runSyncs.Add(1); return nil }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/galaxy/conversations/"+row.ID+"/history" {
			t.Error("history consulted a non-text endpoint", r.Method, r.URL.Path)
			http.Error(w, "invalid", 500)
			return
		}
		claims, ok := verifyFixtureToken(strings.Repeat("s", 32), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if !ok || claims["scope"] != "history-text" || claims["sid"] != row.SessionID || claims["domain"] != row.Domain || claims["sub"] != "conversation:"+row.ID {
			t.Error("unscoped history token")
			http.Error(w, "denied", 403)
			return
		}
		if mode.Load() == 1 {
			http.Error(w, "unavailable", 503)
			return
		}
		ids := r.URL.Query()["runId"]
		if len(ids) == 0 || len(ids) > 50 {
			t.Error("invalid text batch", len(ids))
			http.Error(w, "invalid", 400)
			return
		}
		items := []Object{}
		for _, id := range ids {
			items = append(items, Object{"runId": id, "userInput": "原用户输入", "content": "原回复", "createdAt": f.Now().Unix(), "completedAt": f.Now().Unix(), "status": "INTERNAL_STATUS", "taskProgress": Object{"secret": "INTERNAL"}})
		}
		if mode.Load() == 2 {
			items[0]["runId"] = uuid.NewString()
		}
		_ = json.NewEncoder(w).Encode(Object{"conversationId": row.ID, "sessionId": row.SessionID, "items": items})
	}))
	defer server.Close()
	s.Client, err = New(Configuration{URL: server.URL, SigningKey: strings.Repeat("s", 32)}, Options{Now: f.Now})
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.ReadHistoryPage(ctx, f.Root, "overview", "")
	if err != nil {
		t.Fatal(err)
	}
	runs := page["runs"].([]Object)
	if len(runs) != 51 || calls.Load() != 2 || sourceChecks.Load() != 0 || runSyncs.Load() != 0 {
		t.Fatal("unexpected history side effect or truncated text", len(runs), calls.Load(), sourceChecks.Load(), runSyncs.Load())
	}
	for _, run := range runs {
		if run["displayOnly"] != true || run["status"] != nil || run["taskProgress"] != nil {
			t.Fatal("internal execution fields leaked", run)
		}
		if run["operationId"] != root && run["userInput"] != nil {
			t.Fatal("system feedback became user message", run)
		}
	}
	for _, invalid := range []int32{1, 2} {
		mode.Store(invalid)
		if _, e := s.ReadHistoryPage(ctx, f.Root, "overview", ""); e == nil {
			t.Fatal("failed or foreign text response became history", invalid)
		}
	}
}
