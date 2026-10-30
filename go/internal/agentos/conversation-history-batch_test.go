package agentos

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestConversationHistoryBatchOriginalBindings(t *testing.T) {
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
	root, unknown, retry := uuid.NewString(), uuid.NewString(), uuid.NewString()
	ids := []string{root, unknown, retry}
	for len(ids) < 12 {
		ids = append(ids, uuid.NewString())
	}
	for i, id := range ids {
		result := Object{"runId": id}
		var native any = id
		if i > 0 {
			result["origin"], result["parentOperationId"] = "operation-feedback", root
		}
		if id == unknown {
			native = nil
			result["runId"] = nil
		}
		if id == retry {
			delete(result, "origin")
			delete(result, "parentOperationId")
			result["retryOfOperationId"], result["retryOfRunId"] = root, root
		}
		_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8)`, id, f.Endpoint, row.ID, row.OperatorID, strings.Repeat("a", 64), native, result, f.Now().Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
	}
	var mode atomic.Int32
	var batches, unknownSeen, singleReads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/operations") {
			singleReads.Add(1)
			http.Error(w, "single lookup forbidden", 500)
			return
		}
		batches.Add(1)
		raw, e := base64.RawURLEncoding.DecodeString(r.URL.Query().Get("requests"))
		if e != nil {
			t.Error(e)
			http.Error(w, "invalid", 400)
			return
		}
		var requests []ConversationOperationRequest
		if e = json.Unmarshal(raw, &requests); e != nil || len(requests) > 10 {
			t.Error("invalid batch", e)
			http.Error(w, "invalid", 400)
			return
		}
		if mode.Load() == 1 {
			http.Error(w, "source unavailable", 503)
			return
		}
		items := []Object{}
		for _, request := range requests {
			if request.OperationID == unknown {
				if request.RunID != "" {
					t.Error("unknown locator was guessed")
				}
				unknownSeen.Add(1)
				items = append(items, Object{"operationId": unknown, "runId": nil, "state": "not-recorded", "native": nil})
				continue
			}
			run := Object{"operationId": request.OperationID, "runId": request.OperationID, "status": "COMPLETED", "content": "结果", "userInput": "输入", "events": []any{}}
			if request.OperationID == retry {
				if request.RetryOfOperationID != root || request.RetryOfRunID != root {
					t.Error("lost retry locator")
				}
				run["regeneratedFrom"] = root
			}
			items = append(items, Object{"operationId": request.OperationID, "runId": request.OperationID, "state": "COMPLETED", "native": run})
		}
		if mode.Load() == 2 && len(items) > 1 {
			items[1] = items[0]
		}
		if mode.Load() == 3 && len(items) > 0 {
			items[0]["sessionId"] = uuid.NewString()
		}
		_ = json.NewEncoder(w).Encode(Object{"conversationId": row.ID, "sessionId": row.SessionID, "items": items, "readExpiresAt": f.Now().Unix() + 30})
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
	if len(runs) != 12 || batches.Load() != 2 || unknownSeen.Load() != 1 || singleReads.Load() != 0 {
		t.Fatal("batch lost or bypassed original", len(runs), batches.Load(), unknownSeen.Load(), singleReads.Load())
	}
	for _, run := range runs {
		if run["operationId"] == unknown && run["status"] != "unknown" {
			t.Fatal("unknown was fabricated", run)
		}
		if run["operationId"] == retry && run["logicalTurnId"] != root {
			t.Fatal("retry escaped logical root", run)
		}
	}
	for _, invalid := range []int32{1, 2, 3} {
		mode.Store(invalid)
		if _, e := s.ReadHistoryPage(ctx, f.Root, "overview", ""); e == nil {
			t.Fatal("source or binding failure returned history", invalid)
		}
	}
	if singleReads.Load() != 0 {
		t.Fatal("failure fell back to per-operation GET")
	}
}
