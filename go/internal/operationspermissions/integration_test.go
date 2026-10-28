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
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type directory struct {
	mu     sync.Mutex
	denied map[string]bool
}

func (d *directory) Roles(_ context.Context, _ string, subject string) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.denied[subject] {
		return []string{}, nil
	}
	if subject == "root" || subject == "writer" {
		return []string{"admit-admin"}, nil
	}
	return []string{"admit-reader"}, nil
}
func (d *directory) RolesFresh(ctx context.Context, issuer, subject string) ([]string, error) {
	return d.Roles(ctx, issuer, subject)
}
func object(v any) map[string]any { o, _ := v.(map[string]any); return o }
func text(v any) string           { s, _ := v.(string); return s }
func clone(v any) map[string]any {
	raw, _ := json.Marshal(v)
	var o map[string]any
	json.Unmarshal(raw, &o)
	return o
}
func equal(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func TestPermissionRolesPersonnelHistoryRealPortalAndOriginalJS(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	node := func(mode string, input any) map[string]any {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		if input != nil {
			raw, _ := json.Marshal(input)
			cmd.Stdin = strings.NewReader(string(raw))
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
	fixture := node("setup", nil)
	ids := object(fixture["ids"])
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
	endpoint, issuer := text(fixture["endpoint"]), text(fixture["issuer"])
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: text(ids["root"]), Issuer: issuer, Subject: "root"}}, dir)
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	service := &perms.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now}
	server := httptest.NewServer(perms.Handler{Service: service})
	defer server.Close()
	request := func(who, method, path string, input any, csrf bool) (int, map[string]any) {
		t.Helper()
		var body string
		if input != nil {
			raw, _ := protocol.Encode(input)
			body = string(raw)
		}
		req, _ := http.NewRequest(method, server.URL+"/v1/operations/permissions/"+path, strings.NewReader(body))
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("Content-Type", "application/json")
		token := map[string]string{"root": "R", "writer": "W", "empty": "E"}[who]
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat(token, 43)})
		}
		if csrf {
			req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		}
		res, e := server.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var result map[string]any
		if json.NewDecoder(res.Body).Decode(&result) != nil {
			t.Fatal("HTTP non-JSON response")
		}
		return res.StatusCode, result
	}
	check := func(status int, o map[string]any, want int, code string) {
		t.Helper()
		if status != want || (code != "" && o["error"] != code) {
			t.Fatalf("HTTP %d %s want %d %s", status, jsonText(o), want, code)
		}
	}
	status, catalog := request("root", "GET", "catalog", nil, false)
	check(status, catalog, 200, "")
	source := node("read", nil)
	if !equal(catalog, source["catalog"]) {
		t.Fatal("catalog metadata/lease hash differs from original")
	}
	status, lease := request("root", "GET", "catalog/lease?version="+text(catalog["sourceVersion"]), nil, false)
	check(status, lease, 200, "")
	if lease["unchanged"] != true {
		t.Fatal("catalog lease changed")
	}
	status, o := request("empty", "GET", "roles", nil, false)
	check(status, o, 403, "operations_permission_denied")
	status, o = request("writer", "POST", "roles", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Denied expansion", "description": "", "enabled": true, "permissions": []string{"feedback.update"}}, true)
	check(status, o, 403, "operations_permission_grant_exceeds_authority")
	status, retry := request("root", "POST", "roles", fixture["originalInput"], true)
	check(status, retry, 200, "")
	if retry["replayed"] != true || !equal(object(retry["role"]), object(fixture["original"])["role"]) {
		t.Fatal("original JS role retry changed")
	}
	input := map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": " Go role ", "description": " Narrow local test ", "enabled": true, "permissions": []string{"feedback.read"}}
	status, saved := request("root", "POST", "roles", input, true)
	check(status, saved, 200, "")
	role := object(saved["role"])
	roleID := text(role["id"])
	if role["name"] != "Go role" {
		t.Fatal("role trim lost")
	}
	status, o = request("root", "POST", "roles", input, false)
	check(status, o, 403, "operations_access_denied")
	conflict := clone(input)
	conflict["name"] = "Another intention"
	status, o = request("root", "POST", "roles", conflict, true)
	check(status, o, 409, "operations_permissions_operation_conflict")
	status, o = request("writer", "POST", "roles", input, true)
	check(status, o, 409, "operations_permissions_operation_conflict")
	update := clone(input)
	update["operationId"], update["id"], update["expectedVersion"], update["enabled"] = uuid.NewString(), roleID, 1, false
	status, o = request("root", "POST", "roles", update, true)
	check(status, o, 200, "")
	status, receipt := request("root", "GET", "operations/"+text(input["operationId"]), nil, false)
	check(status, receipt, 200, "")
	if object(object(receipt["result"])["role"])["enabled"] != true {
		t.Fatal("receipt substituted today's disabled role")
	}
	status, o = request("writer", "GET", "operations/"+text(input["operationId"]), nil, false)
	check(status, o, 404, "operations_permissions_operation_not_found")
	ai := clone(input)
	ai["operationId"], ai["name"], ai["subjectScope"] = uuid.NewString(), "AI only", "ai-only"
	status, aiSaved := request("root", "POST", "roles", ai, true)
	check(status, aiSaved, 200, "")
	aiID := object(aiSaved["role"])["id"]
	assignment := map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "operatorId": ids["empty"], "roleId": aiID, "enabled": true}
	status, o = request("root", "POST", "assignments", assignment, true)
	check(status, o, 403, "operations_ai_role_human_assignment_denied")
	badScope := clone(update)
	badScope["operationId"], badScope["expectedVersion"], badScope["subjectScope"] = uuid.NewString(), 2, "ai-only"
	status, o = request("root", "POST", "roles", badScope, true)
	check(status, o, 409, "operations_role_scope_immutable")
	originalRoleID := object(object(fixture["original"])["role"])["id"]
	assignment["operationId"], assignment["roleId"] = uuid.NewString(), originalRoleID
	status, assigned := request("writer", "POST", "assignments", assignment, true)
	check(status, assigned, 200, "")
	_ = assigned
	status, history := request("root", "GET", "history?targetOperatorId="+text(ids["empty"])+"&limit=1", nil, false)
	check(status, history, 200, "")
	if len(history["items"].([]any)) != 1 {
		t.Fatal("person history missing")
	}
	source = node("read", map[string]any{"operationId": input["operationId"]})
	for name, path := range map[string]string{"roles": "roles", "personnel": "personnel", "history": "history?limit=100", "operation": "operations/" + text(input["operationId"])} {
		status, o = request("root", "GET", path, nil, false)
		check(status, o, 200, "")
		if !equal(o, source[name]) {
			t.Fatalf("%s JS↔Go projection differs\nGo %s\nJS %s", name, jsonText(o), jsonText(source[name]))
		}
	}
	self := object(fixture["assignment"])
	selfInput := map[string]any{"operationId": uuid.NewString(), "id": self["id"], "expectedVersion": 1, "operatorId": ids["writer"], "roleId": self["roleId"], "enabled": false}
	status, o = request("writer", "POST", "assignments", selfInput, true)
	check(status, o, 200, "")
	status, o = request("writer", "POST", "assignments", selfInput, true)
	check(status, o, 403, "operations_permission_denied")
	dir.mu.Lock()
	dir.denied["root"] = true
	dir.mu.Unlock()
	status, o = request("root", "POST", "roles", input, true)
	check(status, o, 403, "business_admin_denied")
	var count int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='permission-role-save'", endpoint).Scan(&count); e != nil || count != 5 {
		t.Fatalf("role audit writes %d %v", count, e)
	}
	t.Log("real Cookie/CSRF + current PG roles, JS↔Go role/assignment receipts, catalog/personnel/history parity, self-revoke and directory revoke passed")
}
func jsonText(v any) string { b, _ := protocol.Encode(v); return string(b) }
