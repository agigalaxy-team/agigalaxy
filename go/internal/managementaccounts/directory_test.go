package managementaccounts

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
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type remapTransport struct{ target *url.URL }

func (r remapTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	c := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = r.target.Scheme
	u.Host = r.target.Host
	c.URL = &u
	return http.DefaultTransport.RoundTrip(c)
}
func oracle(t *testing.T, dsn, mode string, input Object) Object {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/management-accounts-interop.mjs"), mode)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	b, _ := json.Marshal(input)
	cmd.Stdin = strings.NewReader(string(b))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original %s %v %s", mode, e, out)
	}
	var o Object
	if json.Unmarshal(out, &o) != nil {
		t.Fatal("invalid original fixture result")
	}
	return o
}
func normalized(v any) any { b, _ := json.Marshal(v); var o any; json.Unmarshal(b, &o); return o }
func eq(t *testing.T, label string, a, b any) {
	t.Helper()
	if !reflect.DeepEqual(normalized(a), normalized(b)) {
		t.Fatalf("%s mismatch\nGo %#v\nJS %#v", label, a, b)
	}
}

func TestOriginalNativeDirectoryAndPublishedGeneration(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	base := oracle(t, dsn, "setup", Object{})
	issuer, endpoint := str(base["issuer"]), str(base["endpoint"])
	var mu sync.Mutex
	mode := "normal"
	counts := map[string]int{}
	writes := []Object{}
	countCalls := 0
	nativeUser := func(id string) Object {
		return Object{"id": id, "username": "user-" + id, "firstName": "小明", "lastName": "王", "email": "user@example.invalid", "emailVerified": true, "enabled": true, "createdTimestamp": float64(1700000000000), "requiredActions": []string{"UPDATE_PASSWORD", "UNKNOWN"}}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		counts[r.Method+" "+path]++
		if strings.HasSuffix(path, "/token") {
			json.NewEncoder(w).Encode(Object{"access_token": "isolated-token", "expires_in": 300})
			return
		}
		if r.Method != "GET" {
			var body any
			if r.Body != nil {
				b, _ := io.ReadAll(r.Body)
				if len(b) > 0 {
					json.Unmarshal(b, &body)
				}
			}
			writes = append(writes, Object{"method": r.Method, "path": path, "body": body})
			if mode == "write-unknown" {
				w.WriteHeader(503)
				return
			}
			if path == "/admin/realms/management/users" {
				w.Header().Set("Location", serverLocation(r, "created"))
				w.WriteHeader(201)
				return
			}
			w.WriteHeader(204)
			return
		}
		if mode == "read-forbidden" {
			w.WriteHeader(403)
			return
		}
		switch {
		case strings.HasSuffix(path, "/users/count"):
			countCalls++
			n := 22
			if mode == "changed" && countCalls%2 == 0 {
				n++
			}
			json.NewEncoder(w).Encode(n)
		case path == "/admin/realms/management/users":
			first, _ := strconv.Atoi(r.URL.Query().Get("first"))
			max, _ := strconv.Atoi(r.URL.Query().Get("max"))
			rows := []any{}
			for i := first; i < 22 && i < first+max; i++ {
				id := strconv.Itoa(i)
				if mode == "duplicate" && i == 1 {
					id = "0"
				}
				u := nativeUser(id)
				if i == 21 {
					u["serviceAccountClientId"] = "service"
				}
				rows = append(rows, u)
			}
			json.NewEncoder(w).Encode(rows)
		case strings.HasSuffix(path, "/role-mappings/realm/available"), strings.HasSuffix(path, "/role-mappings/realm/composite"):
			json.NewEncoder(w).Encode([]any{Object{"id": "admin-role", "name": "galaxy-operations-administrator", "clientRole": false}, Object{"id": "reader-role", "name": "galaxy-operations-reader", "clientRole": false}})
		case strings.HasSuffix(path, "/sessions"):
			json.NewEncoder(w).Encode([]any{Object{"id": "never-projected"}})
		default:
			id := path[strings.LastIndex(path, "/")+1:]
			if id == "missing" {
				w.WriteHeader(404)
				return
			}
			json.NewEncoder(w).Encode(nativeUser(id))
		}
	}))
	defer server.Close()
	origin, _ := url.Parse(server.URL)
	native, e := NewNative(NativeConfig{Issuer: issuer, AdminOrigin: server.URL, Reader: Credential{"reader", "isolated-reader"}, Writer: &Credential{"writer", "isolated-writer"}, Transport: remapTransport{origin}, Now: func() time.Time { return time.Unix(2000000000, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	// Same real HTTP provider, original JS transport and Go transport. The public
	// issuer remains HTTPS; the test-only transport rewrites only network routing.
	js := oracle(t, dsn, "native", Object{"origin": server.URL})
	goOut := Object{}
	count, e := native.Count(ctx)
	if e != nil {
		t.Fatal(e)
	}
	goOut["count"] = count
	page, e := native.Page(ctx, 0, 20)
	if e != nil {
		t.Fatal(e)
	}
	goOut["page"] = Object{"rawCount": page.RawCount, "items": page.Items}
	goOut["get"], e = native.Get(ctx, issuer, "human")
	if e != nil {
		t.Fatal(e)
	}
	goOut["sessions"], e = native.Sessions(ctx, issuer, "human")
	if e != nil {
		t.Fatal(e)
	}
	authorize := func() error { return nil }
	goOut["created"], e = native.Create(ctx, Object{"username": "new-user", "firstName": "新", "lastName": "人", "temporaryPassword": "isolated-password"}, authorize)
	if e != nil {
		t.Fatal(e)
	}
	goOut["profile"], _ = native.Profile(ctx, issuer, "human", Object{"firstName": "更新", "note": "must not be sent"}, authorize)
	goOut["enabled"], _ = native.SetEnabled(ctx, issuer, "human", false, authorize)
	goOut["password"], _ = native.ResetPassword(ctx, issuer, "human", "isolated-password", authorize)
	goOut["logout"], _ = native.Logout(ctx, issuer, "human", authorize)
	goOut["admission"], e = native.Admission(ctx, issuer, "human", "reader", authorize)
	if e != nil {
		t.Fatal(e)
	}
	goOut["remove"], _ = native.Remove(ctx, issuer, "human", authorize)
	eq(t, "native projection/writes", goOut, js)
	mu.Lock()
	sent := len(writes)
	firstWrites := append([]Object{}, writes[:sent/2]...)
	lastWrites := append([]Object{}, writes[sent/2:]...)
	mu.Unlock()
	eq(t, "native exact selected write bodies", lastWrites, firstWrites)
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	index := &Directory{Pool: pool, Endpoint: endpoint, Reader: native, Now: func() time.Time { return time.Unix(2000000000, 0) }}
	r, e := index.Sync(ctx)
	if e != nil || r["state"] != "complete" || r["observedCount"] != int64(21) {
		t.Fatalf("sync %#v %v", r, e)
	}
	source, e := index.Source(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	eq(t, "JS reads Go published source", source, oracle(t, dsn, "source", Object{"origin": server.URL}))
	firstID := source["generationId"]
	// A moving source, duplicate ID, and native failure all retain the original
	// complete generation. No failed generation enters list count/filter/page.
	for _, bad := range []string{"changed", "duplicate", "read-forbidden"} {
		mu.Lock()
		mode = bad
		countCalls = 0
		mu.Unlock()
		r, e = index.Sync(ctx)
		if e != nil || r["state"] != "failed" {
			t.Fatalf("%s result %#v %v", bad, r, e)
		}
		source, e = index.Source(ctx, nil)
		if e != nil || source["generationId"] != firstID || source["coverage"] != "complete-generation" || source["state"] != "unavailable" {
			t.Fatalf("published recovery %s %#v %v", bad, source, e)
		}
		eq(t, "original failed source", source, oracle(t, dsn, "source", Object{"origin": server.URL}))
	}
	mu.Lock()
	mode = "normal"
	mu.Unlock()
	original := oracle(t, dsn, "sync", Object{"origin": server.URL})
	source, e = index.Source(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	eq(t, "Go reads JS published source", source, original["source"])
	var oldCount int
	if e := pool.QueryRow(ctx, "SELECT count(*) FROM operations_management_generations_v1 WHERE endpoint=$1", endpoint).Scan(&oldCount); e != nil || oldCount != 1 {
		t.Fatalf("published cleanup %d %v", oldCount, e)
	}
	// Active lease is respected across implementations.
	_, e = pool.Exec(ctx, `UPDATE operations_management_directory_v1 SET sync_id='99999999-9999-4999-8999-999999999999',lease_until=$2 WHERE endpoint=$1`, endpoint, time.Unix(2000000030, 0))
	if e != nil {
		t.Fatal(e)
	}
	r, e = index.Sync(ctx)
	if e != nil || r["state"] != "syncing" {
		t.Fatalf("lease %#v %v", r, e)
	}
	mu.Lock()
	mode = "write-unknown"
	before := len(writes)
	mu.Unlock()
	r, e = native.ResetPassword(ctx, issuer, "human", "isolated-password", authorize)
	if e != nil || r["state"] != "unknown" {
		t.Fatalf("unknown submission %#v %v", r, e)
	}
	mu.Lock()
	after := len(writes)
	mu.Unlock()
	if after != before+1 {
		t.Fatal("native write was retried")
	}
	_, e = native.Remove(ctx, issuer, "human", func() error { return fault.New("operations_permission_denied", 403) })
	if fault.Code(e) != "operations_permission_denied" {
		t.Fatal(e)
	}
	mu.Lock()
	afterDenied := len(writes)
	mu.Unlock()
	if afterDenied != after {
		t.Fatal("revoked authorization submitted native write")
	}
	for _, bad := range []string{".", "..", "x/y"} {
		if _, e = native.Get(ctx, issuer, bad); fault.Code(e) != "management_identity_not_found" {
			t.Fatalf("target path %s %v", bad, e)
		}
	}
}
func serverLocation(r *http.Request, subject string) string {
	return "http://" + r.Host + "/admin/realms/management/users/" + subject
}
