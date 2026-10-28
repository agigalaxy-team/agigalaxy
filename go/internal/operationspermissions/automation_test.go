package operationspermissions_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAutomationAndHumanAIDelegationOriginalInterop(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	node := func(mode string, input any) map[string]any {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		if input != nil {
			cmd.Stdin = strings.NewReader(jsonText(input))
		}
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original %s %v %s", mode, e, out)
		}
		var o map[string]any
		if json.Unmarshal(out, &o) != nil {
			t.Fatal("invalid oracle output")
		}
		return o
	}
	base := node("setup", nil)
	fixture := node("automation-setup", nil)
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
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: text(ids["root"]), Issuer: issuer, Subject: "root"}}, &directory{denied: map[string]bool{}})
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	ai := &operationsai.Service{Endpoint: endpoint}
	service := &perms.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now, AIWork: ai}
	server := httptest.NewServer(perms.Handler{Service: service})
	defer server.Close()
	request := func(method, path string, input any) (int, map[string]any) {
		t.Helper()
		body := ""
		if input != nil {
			body = jsonText(input)
		}
		req, _ := http.NewRequest(method, server.URL+"/v1/operations/permissions/"+path, strings.NewReader(body))
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
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
	status, o := request("POST", "automation", fixture["originalInput"])
	check(status, o, 200, "")
	if o["replayed"] != true {
		t.Fatal("JS automation replay missing")
	}
	source := node("automation-read", nil)
	status, o = request("GET", "automation", nil)
	check(status, o, 200, "")
	if !equal(o, source["automation"]) {
		t.Fatalf("initial automation differs\nGo%s\nJS%s", jsonText(o), jsonText(source["automation"]))
	}
	accounts := object(fixture["accounts"])
	input := map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Go AI grant", "executorKind": "ai", "mode": "automatic", "enabled": true, "permissions": []string{"feedback.read", "feedback.update"}, "resourceIds": []string{}, "resourceScope": map[string]any{"kind": "eligible"}, "aiAccountId": accounts["governance"]}
	status, saved := request("POST", "automation", input)
	check(status, saved, 200, "")
	grant := object(saved["automation"])
	if grant["bindingState"] != "bound" || grant["executionAvailable"] != false || grant["executionState"] != "not-connected" {
		t.Fatal("saved grant faked execution readiness")
	}
	bad := clone(input)
	bad["operationId"], bad["permissions"] = uuid.NewString(), []string{"ai.delegation.configure"}
	status, o = request("POST", "automation", bad)
	check(status, o, 403, "operations_automation_human_boundary")
	bad = clone(input)
	bad["operationId"] = uuid.NewString()
	delete(bad, "aiAccountId")
	status, o = request("POST", "automation", bad)
	check(status, o, 400, "operations_automation_ai_binding_required")
	bad = clone(fixture["originalInput"])
	bad["operationId"], bad["resourceIds"] = uuid.NewString(), []string{}
	status, o = request("POST", "automation", bad)
	check(status, o, 400, "operations_automation_scope_required")
	status, o = request("GET", "operations/"+text(input["operationId"]), nil)
	check(status, o, 200, "")
	source = node("automation-read", map[string]any{"operationId": input["operationId"]})
	if !equal(o, source["operation"]) {
		t.Fatalf("automation receipt differs Go%s JS%s", jsonText(o), jsonText(source["operation"]))
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	current, e := ai.AuthorizationWithin(ctx, tx, "governance", nil)
	if e != nil {
		t.Fatal(e)
	}
	if !equal(current, source["authorization"]) {
		t.Fatalf("AI authority differs Go%s JS%s", jsonText(current), jsonText(source["authorization"]))
	}
	if _, e = ai.ExecutionRoleWithin(ctx, tx, "governance", text(accounts["governance"]), []string{"ai.delegation.configure"}); e == nil {
		t.Fatal("AI role invented human authority")
	}
	intersection, e := service.ExecutionIntersection(ctx, tx, text(grant["id"]), nil, []string{"feedback.update"}, []string{text(fixture["resource"])})
	if e != nil || intersection["executionAvailable"] != false {
		t.Fatalf("intersection %v", e)
	}
	tx.Rollback(ctx)
	status, o = request("GET", "ai-delegation", nil)
	check(status, o, 200, "")
	if !equal(o, source["delegation"]) {
		t.Fatal("delegation current read differs")
	}
	status, o = request("POST", "ai-delegation", fixture["delegationInput"])
	check(status, o, 200, "")
	if o["replayed"] != true {
		t.Fatal("JS delegation replay missing")
	}
	update := clone(fixture["delegationInput"])
	update["operationId"], update["expectedVersion"], update["enabled"] = uuid.NewString(), 1, false
	status, o = request("POST", "ai-delegation", update)
	check(status, o, 200, "")
	bad = clone(update)
	bad["operationId"], bad["expectedVersion"], bad["targetAiAccountIds"] = uuid.NewString(), 2, []string{text(accounts["overview"])}
	status, o = request("POST", "ai-delegation", bad)
	check(status, o, 403, "operations_ai_delegation_ceiling_denied")
	bad = clone(update)
	bad["operationId"], bad["expectedVersion"], bad["grantablePermissions"] = uuid.NewString(), 2, []string{"ai.roles.create"}
	status, o = request("POST", "ai-delegation", bad)
	check(status, o, 403, "operations_ai_delegation_ceiling_denied")
	source = node("automation-read", map[string]any{"delegationOperationId": update["operationId"]})
	for name, path := range map[string]string{"automation": "automation", "delegation": "ai-delegation", "delegationOperation": "ai-delegation/operations/" + text(update["operationId"]), "history": "history?limit=100"} {
		status, o = request("GET", path, nil)
		check(status, o, 200, "")
		if !equal(o, source[name]) {
			t.Fatalf("%s differs Go%s JS%s", name, jsonText(o), jsonText(source[name]))
		}
	}
	t.Log("original automation scopes/readiness/receipt/current AI roles and human delegation ceiling/version/receipt interop passed")
}
