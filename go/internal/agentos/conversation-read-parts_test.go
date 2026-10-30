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

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestConversationReadLanesDoNotWaitForHistoryOrCards(t *testing.T) {
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
	var health, cards atomic.Int32
	var block atomic.Bool
	entered, release := make(chan struct{}, 1), make(chan struct{})
	defer close(release)
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/health" {
			health.Add(1)
			_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "model": "configured", "conversations": Object{"version": 2, "agentIds": []string{"galaxy-conversation-overview"}, "transport": Object{"events": 1, "cancel": 1, "originalRunLookup": 1}}})
			return
		}
		if block.Load() {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		_ = json.NewEncoder(w).Encode(Object{"runs": []Object{{"runId": "owned-history", "status": "COMPLETED"}}, "readExpiresAt": f.Now().Unix() + 23})
	}))
	defer native.Close()
	s.Client, err = New(Configuration{URL: native.URL, SigningKey: strings.Repeat("s", 32)}, Options{Now: f.Now})
	if err != nil {
		t.Fatal(err)
	}
	s.ToolCards = func(context.Context, operationspermissions.Actor, string) ([]Object, error) {
		cards.Add(1)
		return []Object{{"cardId": uuid.NewString(), "readExpiresAt": f.Now().Unix() + 1}}, nil
	}
	history, err := s.ReadHistory(ctx, f.Root, "overview")
	if err != nil || history["conversationId"] != current.Row.ID || history["readExpiresAt"] != f.Now().Unix()+23 || health.Load() != 0 || cards.Load() != 0 {
		t.Fatal("history waited for unrelated status/cards or inherited a card lease", history, err, health.Load(), cards.Load())
	}
	for _, key := range []string{"toolCards", "managementCapabilities", "runtimeState"} {
		if _, ok := history[key]; ok {
			t.Fatal("unrelated history body", key)
		}
	}
	operation := uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,$5,'not-started','{}',$6)`, operation, f.Endpoint, current.Row.ID, f.Root.ID, strings.Repeat("d", 64), f.Now()); err != nil {
		t.Fatal(err)
	}
	block.Store(true)
	reading, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, e := s.ReadHistory(reading, f.Root, "overview"); done <- e }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("history did not enter its actual native read")
	}
	for _, part := range []string{"cards", "context", "management-capabilities"} {
		r := httptest.NewRequest("GET", "https://admin.example.invalid/v1/operations/agentos/conversations/overview/"+part, nil)
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		w := httptest.NewRecorder()
		ConversationHandler{Service: s, Authority: f.Gateway}.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(part, w.Code, w.Body.String())
		}
		var body Object
		if json.Unmarshal(w.Body.Bytes(), &body) != nil {
			t.Fatal("invalid lane body")
		}
		if part == "context" && (object(body["latestOperation"])["requiresOriginalLookup"] != false || object(body["latestOperation"])["state"] != "not-started") {
			t.Fatal("deterministic unsent turn blocked a new send", body)
		}
		if part == "cards" && body["readExpiresAt"] != nil {
			t.Fatal("stored card list must not carry a read lease", body)
		}
		select {
		case e := <-done:
			t.Fatal("blocked history unexpectedly completed", e)
		default:
		}
	}
	cancel()
	<-done
}

type cardReadCountingAuthority struct {
	operationspermissions.Authority
	checks atomic.Int32
}

func (a *cardReadCountingAuthority) RequireWithin(ctx context.Context, tx pgx.Tx, actor operationspermissions.Actor, action string) (operationspermissions.Actor, error) {
	a.checks.Add(1)
	return a.Authority.RequireWithin(ctx, tx, actor, action)
}
func (a *cardReadCountingAuthority) EffectiveWithin(ctx context.Context, tx pgx.Tx, actor operationspermissions.Actor) (operationspermissions.Actor, error) {
	a.checks.Add(1)
	return a.Authority.EffectiveWithin(ctx, tx, actor)
}

func TestConversationCardBatchBoundedParallelAndFreshRevocation(t *testing.T) {
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
	for i := range 30 {
		turn, tool, card, operation := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
		state := "completed"
		if i < 4 {
			state = "unknown"
		}
		if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,$5,'accepted','{}',$6)`, turn, f.Endpoint, current.Row.ID, f.Root.ID, strings.Repeat("d", 64), f.Now()); err != nil {
			t.Fatal(err)
		}
		if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,'owned-run',$5,'prepare-operation',$6,'completed','{}',$7,$7)`, tool, f.Endpoint, current.Row.ID, turn, tool, strings.Repeat("e", 64), f.Now()); err != nil {
			t.Fatal(err)
		}
		proposal := Object{"kind": "bounded-test-read", "domain": "overview", "target": Object{}, "impact": []any{}, "basis": []any{}}
		result := Object{"operationId": operation, "state": state, "summary": "Original receipt state"}
		if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,$8,$9,$10,$11,$12,$12)`, card, f.Endpoint, current.Row.ID, turn, tool, f.Root.ID, operation, strings.Repeat("f", 64), proposal, state, result, f.Now()); err != nil {
			t.Fatal(err)
		}
	}
	counter := &cardReadCountingAuthority{Authority: f.Permissions.Authority}
	f.Permissions.Authority = counter
	var active, peak, recoveries atomic.Int32
	var revoke atomic.Bool
	entered, release := make(chan struct{}, 4), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	tools := &ConversationTools{Conversations: s, CardReadPermission: func(string) (string, error) { return "ai.roles.read", nil }, RecoverPrepared: func(ctx context.Context, _ operationspermissions.Actor, _ Object, operation string) (Object, error) {
		recoveries.Add(1)
		n := active.Add(1)
		defer active.Add(-1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
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
			if _, e := owner.Exec(ctx, `UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); e != nil {
				return nil, e
			}
		}
		return Object{"operationId": operation, "state": "unknown", "summary": "Original receipt state"}, nil
	}}
	type reply struct {
		items []Object
		err   error
	}
	finished := make(chan reply, 1)
	go func() { items, e := tools.Cards(ctx, f.Root, "overview"); finished <- reply{items, e} }()
	for range 4 {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("pending cards remained serial")
		}
	}
	close(release)
	first := <-finished
	if first.err != nil || len(first.items) != 30 || recoveries.Load() != 4 || peak.Load() != 4 || counter.checks.Load() >= 30 {
		t.Fatal("card batch repeated per-card authority/history or recovered terminal cards", len(first.items), first.err, recoveries.Load(), peak.Load(), counter.checks.Load())
	}
	revoke.Store(true)
	if items, e := tools.Cards(ctx, f.Root, "overview"); fault.Status(e) != 403 || items != nil {
		t.Fatal("revocation after receipt I/O released old cards", items, e)
	}
}
