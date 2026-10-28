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
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestActualSummaryCurrentScopeAndPriorReadLedger(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs("../../..")
	node := func(mode string) Object {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		raw, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("fixture %v %s", e, raw)
		}
		var out Object
		if json.Unmarshal(raw, &out) != nil {
			t.Fatal("invalid fixture")
		}
		return out
	}
	base := node("setup")
	node("automation-setup")
	endpoint, issuer, idRoot := text(base, "endpoint"), text(base, "issuer"), text(object(base["ids"]), "root")
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
