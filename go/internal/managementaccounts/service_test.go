package managementaccounts_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	m "github.com/agigalaxy-team/agigalaxy/go/internal/managementaccounts"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type object = map[string]any

func encode(v any) string   { b, _ := json.Marshal(v); return string(b) }
func objectOf(v any) object { o, _ := v.(map[string]any); return o }
func value(v any) string    { s, _ := v.(string); return s }

type routed struct{ origin *url.URL }

func (rt routed) RoundTrip(r *http.Request) (*http.Response, error) {
	c := r.Clone(r.Context())
	u := *c.URL
	u.Scheme = rt.origin.Scheme
	u.Host = rt.origin.Host
	c.URL = &u
	return http.DefaultTransport.RoundTrip(c)
}

type nativeRoles struct{ n *m.Native }

func (d nativeRoles) Roles(ctx context.Context, i, s string) ([]string, error) {
	return d.RolesFresh(ctx, i, s)
}
func (d nativeRoles) RolesFresh(ctx context.Context, i, s string) ([]string, error) {
	u, e := d.n.Get(ctx, i, s)
	if e != nil {
		return nil, e
	}
	if u == nil || !u.Enabled {
		return []string{}, nil
	}
	if u.Admission == "administrator" {
		return []string{"galaxy-operations-administrator"}, nil
	}
	if u.Admission == "reader" {
		return []string{"galaxy-operations-reader"}, nil
	}
	return []string{}, nil
}
func (d nativeRoles) Invalidate(i, s string) bool { return i == d.n.Issuer() && s != "" }
func TestManagementHTTPDurableNativeCommandsOriginalInterop(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	node := func(mode string, input object) object {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/management-accounts-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		cmd.Stdin = strings.NewReader(encode(input))
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original %s %v %s", mode, e, out)
		}
		var o object
		if json.Unmarshal(out, &o) != nil {
			t.Fatal("original result invalid")
		}
		return o
	}
	fixture := node("service-setup", object{})
	issuer, endpoint, rootID, humanID := value(fixture["issuer"]), value(fixture["endpoint"]), value(fixture["rootId"]), value(fixture["humanId"])
	var mu sync.Mutex
	unknown := false
	submissions := 0
	users := map[string]object{}
	admissions := map[string]string{"root": "administrator", "human": "reader"}
	for _, s := range []string{"root", "human"} {
		users[s] = object{"id": s, "username": s, "firstName": "小明", "lastName": "王", "email": s + "@example.invalid", "emailVerified": true, "enabled": true, "createdTimestamp": float64(1700000000000), "requiredActions": []string{}}
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		if strings.HasSuffix(path, "/token") {
			json.NewEncoder(w).Encode(object{"access_token": "isolated-token", "expires_in": 300})
			return
		}
		base := "/admin/realms/management/users"
		rest := strings.TrimPrefix(path, base)
		parts := strings.Split(strings.TrimPrefix(rest, "/"), "/")
		id := parts[0]
		if r.Method == "GET" {
			switch {
			case rest == "/count":
				json.NewEncoder(w).Encode(len(users))
			case rest == "":
				rows := []any{}
				keys := []string{}
				for k := range users {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				for _, k := range keys {
					rows = append(rows, users[k])
				}
				json.NewEncoder(w).Encode(rows)
			case strings.HasSuffix(path, "/composite"):
				name := "galaxy-operations-" + admissions[id]
				rows := []any{}
				if admissions[id] != "none" {
					rows = append(rows, object{"id": admissions[id] + "-role", "name": name})
				}
				json.NewEncoder(w).Encode(rows)
			case strings.HasSuffix(path, "/available"):
				json.NewEncoder(w).Encode([]any{object{"id": "reader-role", "name": "galaxy-operations-reader"}, object{"id": "administrator-role", "name": "galaxy-operations-administrator"}})
			case strings.HasSuffix(path, "/sessions"):
				json.NewEncoder(w).Encode([]any{object{"id": "not-exposed"}})
			default:
				if u := users[id]; u != nil {
					json.NewEncoder(w).Encode(u)
				} else {
					w.WriteHeader(404)
				}
			}
			return
		}
		submissions++
		if unknown {
			w.WriteHeader(503)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var input object
		if len(b) > 0 {
			json.Unmarshal(b, &input)
		}
		if rest == "" {
			id = "created"
			users[id] = object{"id": id, "username": input["username"], "firstName": input["firstName"], "lastName": input["lastName"], "emailVerified": false, "enabled": true, "requiredActions": []string{"UPDATE_PASSWORD"}}
			admissions[id] = "none"
			w.Header().Set("Location", "http://"+r.Host+base+"/"+id)
			w.WriteHeader(201)
			return
		}
		if strings.HasSuffix(path, "/role-mappings/realm") {
			var roles []object
			json.Unmarshal(b, &roles)
			for _, role := range roles {
				if r.Method == "POST" {
					name := strings.TrimPrefix(value(role["name"]), "galaxy-operations-")
					if name == "administrator" || admissions[id] != "administrator" {
						admissions[id] = name
					}
				} else if r.Method == "DELETE" && role["name"] == "galaxy-operations-administrator" {
					admissions[id] = "reader"
				}
			}
		} else if strings.HasSuffix(path, "/reset-password") {
			users[id]["requiredActions"] = []string{"UPDATE_PASSWORD"}
		} else if strings.HasSuffix(path, "/logout") {
		} else if r.Method == "DELETE" {
			delete(users, id)
		} else {
			for k, v := range input {
				users[id][k] = v
			}
		}
		w.WriteHeader(204)
	}))
	defer provider.Close()
	origin, _ := url.Parse(provider.URL)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	native, e := m.NewNative(m.NativeConfig{Issuer: issuer, AdminOrigin: provider.URL, Reader: m.Credential{ClientID: "reader", ClientSecret: "isolated-reader"}, Writer: &m.Credential{ClientID: "writer", ClientSecret: "isolated-writer"}, Transport: routed{origin}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "galaxy-operations-administrator", ReaderRole: "galaxy-operations-reader", Root: &access.Root{OperatorID: rootID, Issuer: issuer, Subject: "root"}}, nativeRoles{native})
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = now
	permissions := &p.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now}
	service := &m.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Permissions: permissions, Directory: native, Root: &m.Root{OperatorID: rootID, Endpoint: endpoint, Issuer: issuer, ExternalSubject: "root"}, Sessions: gateway.ManagementSessions(), Now: now}
	index := &m.Directory{Pool: pool, Endpoint: endpoint, Reader: native, Now: now}
	if _, e = index.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	api := httptest.NewServer(m.Handler{Service: service})
	defer api.Close()
	request := func(method, path, token string, input any) (int, object) {
		t.Helper()
		body := ""
		if input != nil {
			body = encode(input)
		}
		r, _ := http.NewRequest(method, api.URL+"/v1/operations/management-accounts"+path, strings.NewReader(body))
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		if token != "" {
			r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat(token, 43)})
		}
		res, e := api.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var o object
		if json.NewDecoder(res.Body).Decode(&o) != nil {
			t.Fatal("HTTP result invalid")
		}
		return res.StatusCode, o
	}
	check := func(status int, o object, want int, code string) {
		t.Helper()
		if status != want || code != "" && o["error"] != code {
			t.Fatalf("status%d want%d %s result%s", status, want, code, encode(o))
		}
	}
	same := func(label string, a, b any) {
		t.Helper()
		if !reflect.DeepEqual(objectNormalized(a), objectNormalized(b)) {
			t.Fatalf("%s\nGo%s\nJS%s", label, encode(a), encode(b))
		}
	}
	original := func(method, id string, input object) object {
		return node("service-read", object{"origin": provider.URL, "method": method, "id": id, "input": input})
	}
	status, out := request("GET", "", "", nil)
	check(status, out, 401, "operations_login_required")
	status, out = request("GET", "", "T", nil)
	check(status, out, 403, "operations_permission_denied")
	status, out = request("GET", "", "R", nil)
	check(status, out, 200, "")
	same("list", out, original("list", "", object{}))
	status, out = request("GET", "/"+humanID, "R", nil)
	check(status, out, 200, "")
	same("detail", out, original("detail", humanID, nil))
	command := func(kind string, extra object) (object, object) {
		t.Helper()
		status, detail := request("GET", "/"+humanID, "R", nil)
		check(status, detail, 200, "")
		x := object{"operationId": uuid.NewString(), "expectedVersion": detail["targetVersion"], "kind": kind, "reason": "original intent"}
		for k, v := range extra {
			x[k] = v
		}
		status, result := request("POST", "/"+humanID+"/commands", "R", x)
		check(status, result, 200, "")
		status, receipt := request("GET", "/operations/"+value(x["operationId"]), "R", nil)
		check(status, receipt, 200, "")
		same("original reads Go receipt", receipt, original("operation", value(x["operationId"]), nil))
		return x, result
	}
	profile, got := command("profile-update", object{"firstName": "更新", "note": "local only"})
	if got["state"] != "completed" {
		t.Fatal(encode(got))
	}
	mu.Lock()
	before := submissions
	mu.Unlock()
	status, replayed := request("POST", "/"+humanID+"/commands", "R", profile)
	check(status, replayed, 200, "")
	if replayed["replayed"] != true {
		t.Fatal("missing replay")
	}
	mu.Lock()
	after := submissions
	mu.Unlock()
	if before != after {
		t.Fatal("replay re-submitted")
	}
	status, out = request("GET", "/"+humanID, "R", nil)
	check(status, out, 200, "")
	same("updated detail", out, original("detail", humanID, nil))
	// The management route delegates to the single permission command engine,
	// including its in-transaction current native target gate and original ID.
	authReq := httptest.NewRequest("POST", "https://admin.example.invalid/v1/operations/permissions/roles", nil)
	authReq.Header.Set("Origin", "https://admin.example.invalid")
	authReq.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	authReq.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	actor, e := gateway.AuthorizeOperations(authReq, true, "permissions.roles.write")
	if e != nil {
		t.Fatal(e)
	}
	roleResult, e := permissions.SaveRole(ctx, actor, object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Business reader", "description": "isolated management assignment", "enabled": true, "permissions": []any{"management.accounts.read", "feedback.read"}})
	if e != nil {
		t.Fatal(e)
	}
	roleID := objectOf(roleResult["role"])["id"]
	assignment := object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": roleID, "enabled": true}
	status, out = request("POST", "/"+humanID+"/assignments", "R", assignment)
	check(status, out, 200, "")
	status, out = request("GET", "/"+humanID+"/assignments/operations/"+value(assignment["operationId"]), "R", nil)
	check(status, out, 200, "")
	same("assignment original receipt", out, node("service-read", object{"origin": provider.URL, "method": "assignmentOperation", "id": humanID, "operationId": assignment["operationId"]}))
	status, out = request("GET", "/"+humanID, "R", nil)
	check(status, out, 200, "")
	same("assigned detail", out, original("detail", humanID, nil))
	_, got = command("password-reset", object{"temporaryPassword": "isolated-new-password"})
	if got["state"] != "completed" {
		t.Fatal(encode(got))
	}
	var secrets int
	if e := pool.QueryRow(ctx, `SELECT count(*) FROM operations_management_commands_v1 WHERE input ? 'temporaryPassword' OR result::text LIKE '%isolated-new-password%'`).Scan(&secrets); e != nil || secrets != 0 {
		t.Fatalf("credential persistence %d %v", secrets, e)
	}
	var fence int
	if e := pool.QueryRow(ctx, `SELECT count(*) FROM operations_management_login_fences_v1 WHERE endpoint=$1 AND issuer=$2 AND external_subject='human'`, endpoint, issuer).Scan(&fence); e != nil || fence != 1 {
		t.Fatalf("revoke fence %d %v", fence, e)
	}
	_, got = command("login-disable", nil)
	if got["state"] != "completed" {
		t.Fatal(encode(got))
	}
	_, got = command("login-restore", nil)
	if got["state"] != "completed" {
		t.Fatal(encode(got))
	}
	_, got = command("sessions-revoke", nil)
	if got["state"] != "completed" {
		t.Fatal(encode(got))
	}
	_, got = command("admission-change", object{"action": "promote"})
	if got["state"] != "completed" {
		t.Fatal(encode(got))
	}
	_, got = command("admission-change", object{"action": "demote"})
	if got["state"] != "completed" {
		t.Fatal(encode(got))
	}
	// Original source writes and Go returns its original receipt, never executes.
	status, detail := request("GET", "/"+humanID, "R", nil)
	check(status, detail, 200, "")
	jsCommand := object{"operationId": uuid.NewString(), "expectedVersion": detail["targetVersion"], "kind": "profile-update", "note": "original JS note"}
	jsResult := original("command", humanID, jsCommand)
	status, out = request("POST", "/"+humanID+"/commands", "R", jsCommand)
	check(status, out, 200, "")
	jsResult["replayed"] = true
	same("Go replays original JS", out, jsResult)
	create := object{"operationId": uuid.NewString(), "username": "created-user", "firstName": "新", "lastName": "人", "temporaryPassword": "isolated-create-password", "roleIds": []any{roleID}}
	status, out = request("POST", "", "R", create)
	check(status, out, 200, "")
	if out["state"] != "completed" {
		t.Fatal(encode(out))
	}
	status, out = request("POST", "", "R", create)
	check(status, out, 200, "")
	if out["replayed"] != true {
		t.Fatal("create replay")
	}
	// Root protection follows immutable configured identity even for root itself.
	status, detail = request("GET", "/"+rootID, "R", nil)
	check(status, detail, 200, "")
	status, out = request("POST", "/"+rootID+"/commands", "R", object{"operationId": uuid.NewString(), "expectedVersion": detail["targetVersion"], "kind": "login-disable"})
	check(status, out, 403, "management_root_protected")
	mu.Lock()
	unknown = true
	mu.Unlock()
	x, got := command("profile-update", object{"lastName": "uncertain"})
	if got["state"] != "unknown" {
		t.Fatal(encode(got))
	}
	mu.Lock()
	before = submissions
	mu.Unlock()
	status, out = request("POST", "/"+humanID+"/commands", "R", x)
	check(status, out, 200, "")
	mu.Lock()
	after = submissions
	unknown = false
	mu.Unlock()
	if before != after {
		t.Fatal("unknown operation was retried")
	}
	status, detail = request("GET", "/"+humanID, "R", nil)
	check(status, detail, 200, "")
	status, out = request("POST", "/"+humanID+"/commands", "R", object{"operationId": uuid.NewString(), "expectedVersion": detail["targetVersion"], "kind": "sessions-revoke"})
	check(status, out, 409, "management_operation_pending")
	// Resolve only test-fixture state to exercise delete independently, without
	// treating an unknown real command as safely repeatable.
	admin, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer admin.Close()
	if _, e = admin.Exec(ctx, `DELETE FROM operations_management_commands_v1 WHERE operation_id=$1`, x["operationId"]); e != nil {
		t.Fatal(e)
	}
	deleted, got := command("delete", nil)
	if got["state"] != "completed" {
		t.Fatal(encode(got))
	}
	status, out = request("POST", "/"+humanID+"/commands", "R", deleted)
	check(status, out, 200, "")
	if out["replayed"] != true {
		t.Fatal("deleted target original receipt unavailable")
	}
	status, out = request("GET", "/"+humanID+"/history", "R", nil)
	check(status, out, 200, "")
	same("history", out, original("history", humanID, nil))
	// Body and route authority precede any command parsing/native effects.
	status, out = request("POST", "/"+humanID+"/commands?x=1", "R", object{})
	check(status, out, 404, "not_found")
	status, out = request("GET", "?page=1&page=2", "R", nil)
	check(status, out, 400, "invalid_management_accounts_request")
	status, out = request("GET", "/operations/"+uuid.NewString(), "R", nil)
	check(status, out, 200, "")
	if out["state"] != "not-recorded" {
		t.Fatal(encode(out))
	}
	if m.ID(issuer, "root") != identity.Digest([]byte(issuer+"\x00root")) {
		t.Fatal("root mapping changed")
	}
}
func objectNormalized(v any) any { var o any; json.Unmarshal([]byte(encode(v)), &o); return o }
