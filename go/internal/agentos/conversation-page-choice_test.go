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
	"github.com/jackc/pgx/v5"
)

func TestConversationPageChoiceAndFeedbackBinding(t *testing.T) {
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
	conversation := *current.Row
	roots := []string{}
	insert := func(id string, at time.Time, result Object) {
		t.Helper()
		_, e := owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,native_run_id,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8)`, id, f.Endpoint, conversation.ID, f.Root.ID, strings.Repeat("d", 64), id, result, at)
		if e != nil {
			t.Fatal(e)
		}
	}
	for i := 0; i < 7; i++ {
		id := uuid.NewString()
		roots = append(roots, id)
		insert(id, f.Now().Add(time.Duration(i)*time.Second), Object{"runId": id})
	}
	retry, feedback := uuid.NewString(), uuid.NewString()
	insert(retry, f.Now().Add(8*time.Second), Object{"runId": retry, "retryOfOperationId": roots[0], "retryOfRunId": roots[0]})
	insert(feedback, f.Now().Add(9*time.Second), Object{"runId": feedback, "origin": "operation-feedback", "parentOperationId": roots[0]})
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		if id == "history" {
			claims, valid := verifyFixtureToken(strings.Repeat("s", 32), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
			if !valid || claims["scope"] != "history-text" || claims["sid"] != conversation.SessionID || claims["domain"] != "overview" || claims["sub"] != "conversation:"+conversation.ID {
				t.Error("history token lost its scope/session/owner binding")
				http.Error(w, "denied", 403)
				return
			}
			items := []Object{}
			for _, runID := range r.URL.Query()["runId"] {
				items = append(items, Object{"runId": runID, "userInput": "请求", "content": "已读", "createdAt": f.Now().Unix(), "completedAt": f.Now().Unix()})
			}
			_ = json.NewEncoder(w).Encode(Object{"conversationId": conversation.ID, "sessionId": conversation.SessionID, "items": items})
			return
		}
		if !validOperationID(id) {
			t.Error("history unexpectedly depended on health or full history", r.URL.Path)
			http.Error(w, "unexpected", 500)
			return
		}
		run := Object{"runId": id, "operationId": id, "status": "COMPLETED", "content": "已读", "userInput": "请求", "createdAt": f.Now().Unix(), "events": []any{}}
		if id == retry {
			run["regeneratedFrom"] = roots[0]
		}
		_ = json.NewEncoder(w).Encode(Object{"conversationId": conversation.ID, "sessionId": conversation.SessionID, "operationId": id, "runId": id, "state": "COMPLETED", "native": run})
	}))
	defer native.Close()
	s.Client, err = New(Configuration{URL: native.URL, SigningKey: strings.Repeat("s", 32)}, Options{Now: f.Now})
	if err != nil {
		t.Fatal(err)
	}
	var sourceChecks, runSyncs int
	s.ValidateSources = func(context.Context, Conversation, operationspermissions.Actor) (SourceQualification, error) {
		sourceChecks++
		return SourceQualification{}, fail("synthetic_source_unavailable", 503)
	}
	s.SyncWorkbenchRuns = func(context.Context, Conversation, []Object) error { runSyncs++; return nil }
	page, err := s.ReadHistoryPage(ctx, f.Root, "overview", "")
	if err != nil {
		t.Fatal(err)
	}
	if page["hasMore"] != true || len(page["runs"].([]Object)) != 5 {
		t.Fatal("first page must be five roots", page)
	}
	page, err = s.ReadHistoryPage(ctx, f.Root, "overview", text(page, "nextCursor"))
	if err != nil {
		t.Fatal(err)
	}
	if page["hasMore"] != false || len(page["runs"].([]Object)) != 4 {
		t.Fatal("retries and feedback must stay with older root", page)
	}
	for _, r := range page["runs"].([]Object) {
		if r["displayOnly"] != true || r["taskProgress"] != nil || r["status"] != nil {
			t.Fatal("history exposed control data", r)
		}
		if r["operationId"] == feedback && r["userInput"] != nil {
			t.Fatal("server continuation became a user message", r)
		}
	}

	if sourceChecks != 0 || runSyncs != 0 {
		t.Fatal("pure history consulted sources or synchronized execution", sourceChecks, runSyncs)
	}
	s.ValidateSources = nil
	s.SyncWorkbenchRuns = nil
	tools := &ConversationTools{Conversations: s, CardReadPermission: func(string) (string, error) { return "workbench.read", nil }}
	s.Tools = tools
	tools.Prepare = func(_ context.Context, _ operationspermissions.Actor, _ Conversation, args Object, _ string) (Object, error) {
		return Object{"kind": "fixture", "request": args, "command": args, "target": Object{"label": "受控对象"}, "title": "更新受控对象", "impact": []any{"更新当前说明。"}, "basis": []any{}, "requiredAction": "workbench.read"}, nil
	}
	turn := roots[6]
	bound := boundConversationTool{row: conversation, actor: f.Root, args: Object{"intent": "prepare", "proposalCount": 3, "alternatives": true, "summary": "三个方案"}}
	if _, err = tools.planConversationTurn(ctx, bound, turn); err != nil {
		t.Fatal(err)
	}
	bound.args = Object{"intent": "prepare", "proposalCount": 1, "alternatives": false, "summary": "只做一个"}
	if _, err = tools.planConversationTurn(ctx, bound, turn); err == nil {
		t.Fatal("three-choice goal was silently reduced")
	}
	parentCommand, err := s.command(ctx, turn)
	if err != nil {
		t.Fatal(err)
	}
	inherited, err := s.inheritedTurnPlan(ctx, parentCommand)
	if err != nil || inherited["proposalCount"] != int64(3) {
		t.Fatal("retry lost original three-choice goal", inherited, err)
	}
	cards := []Object{}
	for i := 0; i < 3; i++ {
		call := uuid.NewString()
		_, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1::uuid,$2,$3,$4::uuid,$4::text,$1::text,'prepare-operation',$5,'started',$6,$6)`, call, f.Endpoint, conversation.ID, turn, strings.Repeat("e", 64), f.Now())
		if err != nil {
			t.Fatal(err)
		}
		bound.callID = call
		bound.args = Object{"option": i}
		card, err := tools.prepareCard(ctx, bound, Object{"turnId": turn})
		if err != nil {
			t.Fatal(err)
		}
		cards = append(cards, object(card["card"]))
	}
	if _, err = tools.prepareCard(ctx, boundConversationTool{row: conversation, actor: f.Root, callID: bound.callID, args: Object{"option": 4}}, Object{"turnId": turn}); err == nil {
		t.Fatal("fourth candidate admitted")
	}
	var executions int
	tools.ExecutePrepared = func(_ context.Context, _ operationspermissions.Actor, _ Object, operation string, _ func(context.Context, pgx.Tx) (operationspermissions.Actor, error)) (Object, error) {
		executions++
		return Object{"operationId": operation, "state": "completed", "summary": "说明已更新。", "effectExecuted": true}, nil
	}
	authorize := func(context.Context) (operationspermissions.Actor, error) { return f.Root, nil }
	chosen := cards[1]
	view, err := tools.Confirm(ctx, f.Root, "overview", text(chosen, "cardId"), Object{"cardId": chosen["cardId"], "operationId": chosen["operationId"]}, authorize)
	if err != nil {
		t.Fatal(err)
	}
	if view["state"] != "completed" || executions != 1 {
		t.Fatal("selection did not execute once", view, executions)
	}
	other := cards[0]
	if _, err = tools.Confirm(ctx, f.Root, "overview", text(other, "cardId"), Object{"cardId": other["cardId"], "operationId": other["operationId"]}, authorize); err == nil {
		t.Fatal("sibling remained executable")
	}
	if executions != 1 {
		t.Fatal("alternative executed twice")
	}
	feedbackAck, err := tools.CardFeedback(ctx, f.Root, "overview", text(chosen, "cardId"), false, authorize)
	if err != nil || feedbackAck["state"] != "not-started" || !validOperationID(text(feedbackAck, "operationId")) {
		t.Fatal("missing stable feedback locator", feedbackAck, err)
	}
	originalFeedback := text(feedbackAck, "operationId")
	insert(originalFeedback, f.Now().Add(11*time.Second), Object{"operationId": originalFeedback, "runId": originalFeedback, "origin": "operation-feedback", "parentOperationId": turn, "feedbackCardId": chosen["cardId"]})
	trusted, err := s.AuthorizeNative(ctx, Object{"conversationId": conversation.ID, "operation": "run", "turnId": originalFeedback})
	if err != nil || object(trusted["receiptFeedback"])["state"] != "completed" || object(trusted["receiptFeedback"])["operationId"] != chosen["operationId"] {
		t.Fatal("trusted feedback did not bind actual original receipt", trusted, err)
	}
	again, err := tools.CardFeedback(ctx, f.Root, "overview", text(chosen, "cardId"), true, authorize)
	if err != nil || again["operationId"] != originalFeedback || executions != 1 {
		t.Fatal("feedback replay did not reuse original", again, err)
	}

}
