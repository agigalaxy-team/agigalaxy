package operationspermissions_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestFiveAIAccountsHumanHTTPAndStoredCurrentAuthority(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	currentFixture := operationsfixture.New(t, owner)
	base := currentFixture.Data
	ids := object(base["ids"])
	endpoint, issuer := text(base["endpoint"]), text(base["issuer"])
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	dir := &directory{denied: map[string]bool{}}
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: text(ids["root"]), Issuer: issuer, Subject: "root"}}, dir)
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	service := &perms.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway, Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	server := httptest.NewServer(perms.AIWorkHandler{Service: service})
	defer server.Close()
	request := func(who, method, path string, input any) (int, map[string]any) {
		t.Helper()
		body := ""
		if input != nil {
			body = jsonText(input)
		}
		req, _ := http.NewRequest(method, server.URL+"/v1/operations/ai-work-accounts"+path, strings.NewReader(body))
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		token := map[string]string{"root": "R", "empty": "E"}[who]
		req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat(token, 43)})
		res, e := server.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var o map[string]any
		if json.NewDecoder(res.Body).Decode(&o) != nil {
			t.Fatal("nonJSON")
		}
		return res.StatusCode, o
	}
	check := func(status int, o map[string]any, want int, code string) {
		t.Helper()
		if status != want || code != "" && o["error"] != code {
			t.Fatalf("status%d %s want%d %s", status, jsonText(o), want, code)
		}
	}
	status, pending := request("root", "GET", "", nil)
	check(status, pending, 200, "")
	if object(pending["initialization"])["recordedCount"] != float64(0) || len(pending["items"].([]any)) != 0 {
		t.Fatal("AI list initialized identities or permissions")
	}
	fixture := currentFixture.Automation(t)
	accounts := object(fixture["accounts"])
	source := currentFixture.AIRead(t, map[string]any{})
	for name, path := range map[string]string{"list": "", "detail": "/governance", "history": "/governance/history", "runtime": "/governance/runtime"} {
		status, o := request("root", "GET", path, nil)
		check(status, o, 200, "")
		if !equal(o, source[name]) {
			t.Fatalf("AI %s differs\nGo%s\nJS%s", name, jsonText(o), jsonText(source[name]))
		}
	}
	originalInput := map[string]any{"operationId": uuid.NewString(), "kind": "profile-save", "expectedVersion": 2, "name": " Original current name ", "description": " Original current profile "}
	original := currentFixture.AICommand(t, map[string]any{"domain": "governance", "command": originalInput})
	status, retry := request("root", "POST", "/governance/commands", originalInput)
	check(status, retry, 200, "")
	if retry["replayed"] != true || !equal(retry["result"], original["result"]) {
		t.Fatal("original AI profile replay changed")
	}
	state := map[string]any{"operationId": uuid.NewString(), "kind": "state-save", "expectedVersion": 3, "enabled": false}
	status, disabled := request("root", "POST", "/governance/commands", state)
	check(status, disabled, 200, "")
	if object(object(disabled["result"])["account"])["authorizationVersion"] != float64(3) {
		t.Fatal("state did not fence current AI authorization")
	}
	assignment := map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": object(object(base["original"])["role"])["id"], "enabled": true}
	status, assigned := request("root", "POST", "/governance/assignments", assignment)
	check(status, assigned, 200, "")
	if object(object(assigned["result"])["account"])["version"] != float64(5) {
		t.Fatal("AI assignment account version not advanced")
	}
	status, o := request("root", "GET", "/operations/"+text(assignment["operationId"]), nil)
	check(status, o, 200, "")
	source = currentFixture.AIRead(t, map[string]any{"operationId": assignment["operationId"]})
	if !equal(o, source["operation"]) {
		t.Fatal("AI role assignment receipt projection differs")
	}
	status, o = request("empty", "GET", "", nil)
	check(status, o, 403, "operations_permission_denied")
	bad := map[string]any{"operationId": uuid.NewString(), "kind": "profile-save", "expectedVersion": 5, "name": "Incomplete"}
	status, o = request("root", "POST", "/governance/commands", bad)
	check(status, o, 400, "invalid_operations_ai_work_request")
	state["operationId"], state["expectedVersion"], state["enabled"] = uuid.NewString(), 5, true
	status, o = request("root", "POST", "/governance/commands", state)
	check(status, o, 200, "")
	source = currentFixture.AIRead(t, map[string]any{})
	for name, path := range map[string]string{"list": "", "detail": "/governance", "history": "/governance/history", "runtime": "/governance/runtime"} {
		status, o = request("root", "GET", path, nil)
		check(status, o, 200, "")
		if !equal(o, source[name]) {
			t.Fatalf("final AI %s differs Go%s JS%s", name, jsonText(o), jsonText(source[name]))
		}
	}
	// A private durable record resolves the original person without any browser
	// session. It must still check current native/PG human and fixed AI rights.
	if _, e = owner.Exec(ctx, "DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1", endpoint); e != nil {
		t.Fatal(e)
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	stored, e := service.StoredHumanAIWithin(ctx, tx, text(ids["root"]), "governance", text(accounts["governance"]), "query", "feedback.read")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = gateway.RequireWithin(ctx, tx, stored, "feedback.read"); fault.Code(e) != "business_admin_denied" {
		t.Fatalf("stored proof borrowed portal authority %v", e)
	}
	if _, e = service.StoredHumanAIWithin(ctx, tx, text(ids["root"]), "governance", text(accounts["overview"]), "query", "feedback.read"); fault.Code(e) != "operations_ai_work_not_initialized" {
		t.Fatalf("fixed AI replaced %v", e)
	}
	tx.Rollback(ctx)
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	forged := perms.Actor{ID: text(ids["root"]), Endpoint: endpoint, Role: "administrator", Permissions: stored.Permissions}
	if _, e = service.HumanAIWithin(ctx, tx, forged, "governance", "query", "feedback.read"); fault.Code(e) != "business_admin_denied" {
		t.Fatalf("self-reported actor accepted %v", e)
	}
	tx.Rollback(ctx)
	dir.mu.Lock()
	dir.denied["root"] = true
	dir.mu.Unlock()
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	_, e = service.StoredHumanAIWithin(ctx, tx, text(ids["root"]), "governance", text(accounts["governance"]), "query", "feedback.read")
	tx.Rollback(ctx)
	if fault.Code(e) != "business_admin_denied" {
		t.Fatalf("stored person lost current-native fence %v", e)
	}
	t.Log("five-position real human HTTP reads/commands/assignment/receipt and current stored-person/fixed-AI authorization passed without portal Cookie")
}
