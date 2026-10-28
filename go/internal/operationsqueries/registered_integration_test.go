package operationsqueries

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type registeredProviderRoute struct{ origin *url.URL }

func (t registeredProviderRoute) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	u := *r.URL
	u.Scheme, u.Host = t.origin.Scheme, t.origin.Host
	clone.URL = &u
	return http.DefaultTransport.RoundTrip(clone)
}
func TestActualRegisteredQueriesUseCurrentQueryProofAndExcludeIdentitySecrets(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs("../../..")
	node := func(file, mode string, input Object) Object {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, file), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		cmd.Stdin = strings.NewReader(encoded(input))
		raw, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original %s %v %s", mode, e, raw)
		}
		var out Object
		if json.Unmarshal(raw, &out) != nil {
			t.Fatalf("invalid original %s", raw)
		}
		return out
	}
	base := node("scripts/go/operations-permissions-interop.mjs", "setup", nil)
	node("scripts/go/operations-permissions-interop.mjs", "automation-setup", Object{})
	endpoint, issuer, rootID := str(base["endpoint"]), str(base["issuer"]), str(object(base["ids"])["root"])
	fixture := node("go/internal/operationsqueries/testdata/interop.mjs", "seed-registered", Object{"endpoint": endpoint, "rootId": rootID})
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: rootID, Issuer: issuer, Subject: "root"}}, directory{})
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = now
	p := &operationspermissions.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	req := httptest.NewRequest("GET", "https://admin.example.invalid/v1/operations/agentos", nil)
	req.Header.Set("Origin", "https://admin.example.invalid")
	req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	human, e := gateway.AuthorizeOperations(req, false, "workbench.read")
	if e != nil {
		t.Fatal(e)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/token"):
			json.NewEncoder(w).Encode(Object{"access_token": "isolated-reader-token", "expires_in": 300})
		case r.URL.Path == "/admin/realms/website/users/count":
			json.NewEncoder(w).Encode(2)
		case r.URL.Path == "/admin/realms/website/users":
			json.NewEncoder(w).Encode([]Object{{"id": "registered-one", "email": "one-private@example.invalid", "emailVerified": true, "enabled": true, "firstName": "Registered", "lastName": "One", "createdTimestamp": 1700000000000}, {"id": "registered-two", "email": "two-private@example.invalid", "emailVerified": false, "enabled": true, "firstName": "Registered", "lastName": "Two", "createdTimestamp": 1700000001000}})
		case strings.HasSuffix(r.URL.Path, "/credentials"), strings.HasSuffix(r.URL.Path, "/federated-identity"), strings.HasSuffix(r.URL.Path, "/sessions"):
			json.NewEncoder(w).Encode([]any{})
		case strings.Contains(r.URL.Path, "/admin/realms/website/users/"):
			id := strings.TrimPrefix(r.URL.Path, "/admin/realms/website/users/")
			if id != "registered-one" && id != "registered-two" {
				w.WriteHeader(404)
				return
			}
			n := int64(1700000000000)
			name, verified := "One", true
			if id == "registered-two" {
				n += 1000
				name, verified = "Two", false
			}
			json.NewEncoder(w).Encode(Object{"id": id, "email": strings.TrimPrefix(id, "registered-") + "-private@example.invalid", "emailVerified": verified, "enabled": true, "firstName": "Registered", "lastName": name, "createdTimestamp": n, "access": Object{"manage": false}})
		default:
			t.Errorf("unexpected provider route %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	origin, _ := url.Parse(provider.URL)
	native, e := registeredusers.NewNative(registeredusers.NativeConfig{Issuer: "https://website.example.invalid/realms/website", AdminOrigin: provider.URL, Reader: registeredusers.Credential{ClientID: "reader", ClientSecret: "isolated-reader"}, Now: now, Transport: registeredProviderRoute{origin}})
	if e != nil {
		t.Fatal(e)
	}
	workerCfg := owner.Config()
	workerCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, e := pgxpool.NewWithConfig(ctx, workerCfg)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	index := &registeredusers.Directory{Pool: worker, Endpoint: endpoint, Reader: native, Now: now}
	if _, e = index.Sync(ctx); e != nil {
		t.Fatal(e)
	}
	q := &Service{Pool: pool, Permissions: p, RegisteredUsers: &registeredusers.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Directory: native, Now: now}, Now: now}
	var referenceID string
	inputs := []Object{{"module": "registered-users", "view": "list"}, {"module": "registered-users", "view": "list", "filters": Object{"page": 1, "pageSize": 20, "source": "registered", "query": "Registered"}}}
	for _, input := range inputs {
		got, e := q.Query(ctx, human, "overview", "query-operations", input)
		if e != nil {
			t.Fatal(e)
		}
		want := node("go/internal/operationsqueries/testdata/interop.mjs", "query", Object{"endpoint": endpoint, "rootId": rootID, "origin": provider.URL, "domain": "overview", "tool": "query-operations", "arguments": input})
		if !mustEqual(got, want) {
			t.Fatalf("registered whole query differs Go%s JS%s", encoded(got), encoded(want))
		}
		for _, v := range got["evidenceRefs"].([]any) {
			r := object(v)
			if r["kind"] == "registered-user" {
				referenceID = str(r["id"])
			}
		}
		for _, secret := range []string{"private@example.invalid", "website.example.invalid", "registered-one", "isolated-reader"} {
			if strings.Contains(encoded(got), secret) {
				t.Fatalf("identity secret leaked %s", secret)
			}
		}
	}
	if referenceID == "" {
		t.Fatal("actual source yielded no registered reference")
	}
	input := Object{"kind": "registered-user", "id": referenceID}
	got, e := q.Query(ctx, human, "overview", "read-operation-object", input)
	if e != nil {
		t.Fatal(e)
	}
	want := node("go/internal/operationsqueries/testdata/interop.mjs", "query", Object{"endpoint": endpoint, "rootId": rootID, "origin": provider.URL, "domain": "overview", "tool": "read-operation-object", "arguments": input})
	if !mustEqual(got, want) {
		t.Fatalf("registered detail differs Go%s JS%s", encoded(got), encoded(want))
	}
	if _, e = q.Query(ctx, human, "overview", "query-operations", Object{"module": "registered-users", "view": "list", "filters": Object{"query": "one-private@example.invalid"}}); fault.Status(e) != 403 {
		t.Fatalf("AI query searched protected email %v", e)
	}
	verifySystemQuerySources(t, ctx, q, owner, gateway, req, human, endpoint, rootID, now, node)
	if _, e = owner.Exec(ctx, `UPDATE operations_ai_work_assignments_v1 SET enabled=false WHERE endpoint=$1 AND role_id=$2`, endpoint, object(fixture["role"])["id"]); e != nil {
		t.Fatal(e)
	}
	if _, e = q.Query(ctx, human, "overview", "read-operation-object", input); e == nil {
		t.Fatal("revoked query role retained registered source")
	}
}
