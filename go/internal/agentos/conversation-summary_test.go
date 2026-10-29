package agentos

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsqueries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestActualSummaryCurrentScopeAndPriorReadLedger(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	role, err := f.Permissions.SaveRole(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Summary original receipt reads", "description": "Explicit read scope for the three synthetic card kinds", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"feedback.read", "content.read", "accounts.read"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": object(role["role"])["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	endpoint, issuer, idRoot := f.Endpoint, f.Issuer, f.IDs["root"]
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	directory := &conversationDirectory{}
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: idRoot, Issuer: issuer, Subject: "root"}}, directory)
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	p := &operationspermissions.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	c := &Conversations{Pool: pool, Endpoint: endpoint, Permissions: p, Now: now}
	request := httptest.NewRequest("GET", "https://admin.example.invalid/v1/operations/summary", nil)
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	human, e := gateway.AuthorizeOperations(request, false, "workbench.read")
	if e != nil {
		t.Fatal(e)
	}
	current, e := c.Session(ctx, human, "overview", true)
	if e != nil {
		t.Fatal(e)
	}
	prior, turn := uuid.NewString(), uuid.NewString()
	for _, v := range []struct {
		id string
		at time.Time
	}{{prior, now().Add(-time.Minute)}, {turn, now()}} {
		if _, e = pool.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted','{}',$6)`, v.id, endpoint, current.Row.ID, idRoot, strings.Repeat("d", 64), v.at); e != nil {
			t.Fatal(e)
		}
	}
	for i, metadata := range []Object{{"module": "messaging", "view": "plans", "state": "available", "raw": "synthetic private prose"}, {"state": "available", "code": "secret raw prose"}} {
		at := now().Add(-50*time.Second + time.Duration(i)*time.Second)
		if _, e = pool.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,'native-summary',$5,'query-operations',$6,'completed',$7,$8,$8)`, uuid.NewString(), endpoint, current.Row.ID, prior, uuid.NewString(), strings.Repeat("e", 64), metadata, at); e != nil {
			t.Fatal(e)
		}
	}
	tools := &ConversationTools{Conversations: c}
	q := &operationsqueries.Service{Pool: pool, Permissions: p, Now: now}
	q.SummaryContext = func(ctx context.Context, a operationspermissions.Actor, d string, b Object) (Object, error) {
		return tools.SummaryContext(ctx, a, d, b, SummaryContextReaders{})
	}
	q.RecheckContext = tools.RecheckContext
	bound := Object{"conversationId": current.Row.ID, "turnId": turn}
	result, e := q.Summary(ctx, human, "overview", bound)
	if e != nil {
		t.Fatal(e)
	}
	if result["reason"] != "summary-not-connected" {
		t.Fatalf("missing source was fabricated %v", result)
	}
	receipts := object(result["priorReadReceipts"])["items"].([]any)
	if len(receipts) != 2 || object(receipts[0])["view"] != "plans" || object(receipts[1])["module"] != nil || object(receipts[1])["code"] != nil {
		t.Fatalf("closed receipt mismatch %v", receipts)
	}
	raw, _ := json.Marshal(result)
	if strings.Contains(string(raw), "synthetic private prose") {
		t.Fatal("private ledger prose leaked")
	}
	if _, e = q.Summary(ctx, operationspermissions.Actor{ID: human.ID, Role: human.Role}, "overview", bound); fault.Status(e) != 403 {
		t.Fatalf("forged actor accepted %v", e)
	}
	if _, e = q.Summary(ctx, human, "overview", Object{"conversationId": current.Row.ID, "turnId": uuid.NewString()}); fault.Status(e) != 403 {
		t.Fatalf("unbound turn accepted %v", e)
	}
	// The production reader set has no bespoke PriorAction callback. Completed
	// cards must use the owning exact receipt, not make the whole summary fail.
	var operations atomic.Int32
	var expectedTarget string
	for i, kind := range []string{"feedback-update", "content-visibility", "account-restriction", "feedback-update"} {
		cardID, toolID, operationID, target := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
		if i == 0 {
			expectedTarget = target
		}
		request := Object{"kind": kind, "targetId": target}
		if kind == "content-visibility" {
			request["targetKind"] = "post"
		}
		proposal := Object{"kind": kind, "domain": "overview", "request": request, "title": "synthetic private prose", "target": Object{"id": target, "label": "synthetic private prose"}}
		if _, e = pool.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,'native-summary',($1::uuid)::text,'prepare-operation',$5,'completed','{}',$6,$6)`, toolID, endpoint, current.Row.ID, prior, strings.Repeat("e", 64), now().Add(-45*time.Second)); e != nil {
			t.Fatal(e)
		}
		receipt := Object{"operationId": operationID, "state": "completed"}
		if i == 0 {
			receipt["receipt"] = Object{"operationId": operationID, "revision": 2, "title": "synthetic private prose"}
		}
		if _, e = pool.Exec(ctx, `INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,$8,$9,'completed',$10,$11,$11)`, cardID, endpoint, current.Row.ID, prior, toolID, human.ID, operationID, strings.Repeat(strings.ReplaceAll(cardID, "-", ""), 2), proposal, receipt, now().Add(-40*time.Second)); e != nil {
			t.Fatal(e)
		}
	}
	tools.CardReadPermission = func(kind string) (string, error) {
		permission := map[string]string{"feedback-update": "feedback.read", "content-visibility": "content.read", "account-restriction": "accounts.read"}[kind]
		if permission == "" {
			return "", fail("operations_agentos_action_not_connected", 503)
		}
		return permission, nil
	}
	tools.RecoverPrepared = func(ctx context.Context, actor operationspermissions.Actor, proposal Object, operation string) (Object, error) {
		operations.Add(1)
		if actor.ID != human.ID || actor.AIProof == nil {
			t.Fatal("original receipt lost current human/fixed-AI scope")
		}
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	result, e = q.Summary(ctx, human, "overview", bound)
	if e != nil {
		t.Fatal("completed cards required an unconnected callback", e)
	}
	actionsResult := object(result["priorActionReceipts"])
	actionItems := actionsResult["items"].([]any)
	if actionsResult["availability"] != "partial" || len(actionItems) != 1 {
		t.Fatal("a missing/withdrawn original receipt erased the other action", actionsResult)
	}
	reference := object(object(actionItems[0])["reference"])
	if reference["kind"] != "feedback" || reference["id"] != expectedTarget || object(reference["read"])["tool"] != "read-operation-object" || object(actionItems[0])["currentRead"] != nil {
		t.Fatal("original action did not retain its minimal current-read locator", actionItems)
	}
	if operations.Load() != 3 {
		t.Fatal("summary re-read a verifiable terminal receipt or skipped legacy recovery", operations.Load())
	}
	raw, _ = json.Marshal(result)
	if strings.Contains(string(raw), "synthetic private prose") {
		t.Fatal("summary restored old source prose through an action receipt")
	}
	if _, e = pool.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=$3 WHERE endpoint=$1 AND id=$2`, endpoint, turn, Object{"taskId": uuid.NewString()}); e != nil {
		t.Fatal(e)
	}
	if _, e = q.Summary(ctx, human, "overview", bound); fault.Status(e) != 503 {
		t.Fatalf("missing bound task reader fabricated %v", e)
	}
	if _, e = pool.Exec(ctx, `UPDATE operations_agentos_conversations_v1 SET retired_at=$3,retirement_reason='source-changed' WHERE endpoint=$1 AND id=$2`, endpoint, current.Row.ID, now()); e != nil {
		t.Fatal(e)
	}
	if e = tools.RecheckContext(ctx, human, "overview", bound); fault.Code(e) != "operations_agentos_source_changed" {
		t.Fatalf("retired scope remained valid %v", e)
	}
}

func TestPriorActionReferenceUsesOnlyOriginalLocator(t *testing.T) {
	for _, value := range []struct{ action, target, kind string }{
		{"content-visibility", "post", "post"}, {"content-curation", "reply", "reply"},
		{"feedback-update", "", "feedback"}, {"account-restriction", "", "account"},
	} {
		id := uuid.NewString()
		proposal := Object{"kind": value.action, "request": Object{"kind": value.action, "targetKind": value.target, "targetId": id}, "target": Object{"label": "old prose"}}
		reference := priorActionReference(proposal)
		if reference["kind"] != value.kind || reference["id"] != id || len(reference) != 3 {
			t.Fatal("invalid action reference", reference)
		}
		object(proposal["request"])["targetId"] = "untrusted-locator"
		if priorActionReference(proposal) != nil {
			t.Fatal("invalid durable locator accepted")
		}
	}
}

func TestSummaryCardBatchTerminalReceiptsBoundedRecoveryAndRevocation(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	if _, err := f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": object(automation["role"])["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	cards := []*conversationCard{}
	var legacy, unrelated string
	for i := range 7 {
		operation := uuid.NewString()
		card := &conversationCard{ID: uuid.NewString(), ConversationID: current.Row.ID, OperatorID: f.Root.ID, Domain: "overview", OperationID: operation, State: "unknown", Proposal: Object{"kind": "feedback-update"}, Result: Object{}}
		if i >= 4 {
			card.State = "completed"
			card.Result = Object{"operationId": operation, "state": "completed", "receipt": Object{"operationId": operation, "revision": 2}}
			if i == 5 {
				legacy = operation
				delete(object(card.Result["receipt"]), "operationId")
			}
			if i == 6 {
				unrelated = operation
				object(card.Result["receipt"])["operationId"] = uuid.NewString()
			}
		}
		cards = append(cards, card)
	}
	var calls, active, peak atomic.Int32
	var revoke atomic.Bool
	entered, release := make(chan struct{}, 4), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	tools := &ConversationTools{Conversations: s, CardReadPermission: func(string) (string, error) { return "feedback.read", nil }}
	tools.RecoverPrepared = func(ctx context.Context, _ operationspermissions.Actor, _ Object, operation string) (Object, error) {
		calls.Add(1)
		n := active.Add(1)
		defer active.Add(-1)
		for {
			previous := peak.Load()
			if n <= previous || peak.CompareAndSwap(previous, n) {
				break
			}
		}
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if revoke.CompareAndSwap(true, false) {
			if _, err := owner.Exec(ctx, `UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); err != nil {
				return nil, err
			}
		}
		if operation == unrelated {
			return Object{"operationId": uuid.NewString(), "state": "completed", "receipt": Object{"operationId": operation}}, nil
		}
		receipt := Object{"operationId": operation, "revision": 1}
		if operation == legacy {
			delete(receipt, "operationId")
		}
		return Object{"operationId": operation, "state": "completed", "receipt": receipt}, nil
	}
	type response struct {
		values map[string]Object
		err    error
	}
	finished := make(chan response, 1)
	go func() {
		values, err := tools.summaryCardBatch(ctx, f.Root, current.Row, cards, cards, SummaryContextReaders{})
		finished <- response{values, err}
	}()
	for range 4 {
		select {
		case <-entered:
		case early := <-finished:
			t.Fatal("summary batch ended before four original reads; check fixture scope", len(early.values), early.err)
		case <-time.After(3 * time.Second):
			t.Fatal("unresolved summary receipts remained serial")
		}
	}
	close(release)
	first := <-finished
	if first.err != nil || len(first.values) != 6 || calls.Load() != 6 || peak.Load() != 4 || first.values[cards[6].ID] != nil || first.values[cards[5].ID] == nil {
		t.Fatal("summary re-read terminal cards, accepted an unrelated receipt, or duplicated recovery", len(first.values), first.err, calls.Load(), peak.Load())
	}
	revoke.Store(true)
	values, err := tools.summaryCardBatch(ctx, f.Root, current.Row, cards, cards, SummaryContextReaders{})
	if err != nil || len(values) != 0 {
		t.Fatal("summary released receipts after fixed-AI withdrawal", values, err)
	}
}
