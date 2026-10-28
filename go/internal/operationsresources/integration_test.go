package operationsresources_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	res "github.com/agigalaxy-team/agigalaxy/go/internal/operationsresources"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type object = map[string]any

func obj(v any) object { o, _ := v.(map[string]any); return o }
func str(v any) string { s, _ := v.(string); return s }
func enc(v any) []byte { b, _ := protocol.Encode(v); return b }
func equal(t *testing.T, a, b any) {
	t.Helper()
	x, e := identity.Canonical(a)
	y, f := identity.Canonical(b)
	if e != nil || f != nil || !bytes.Equal(x, y) {
		t.Fatalf("original differed\nGo%s\nJS%s\n%v %v", x, y, e, f)
	}
}

type directory struct{}

func (directory) Roles(context.Context, string, string) ([]string, error) {
	return []string{"admit-admin"}, nil
}
func (d directory) RolesFresh(ctx context.Context, i, s string) ([]string, error) {
	return d.Roles(ctx, i, s)
}
func TestOriginalResourcePublicSourceVisibilityAndPrivateLatestMaintenance(t *testing.T) {
	testResources(t, false)
}
func TestOriginalMethodPrivateLatestMaintenanceOnly(t *testing.T) { testResources(t, true) }
func testResources(t *testing.T, methodsOnly bool) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	path := filepath.Join(t.TempDir(), "resources-fixture.json")
	node := func(script, mode string, input object, args ...string) object {
		t.Helper()
		cmd := exec.Command("node", append([]string{script, mode}, args...)...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		cmd.Stdin = bytes.NewReader(enc(input))
		b, e := cmd.Output()
		if e != nil {
			if x, ok := e.(*exec.ExitError); ok {
				t.Fatalf("original %s: %s", mode, x.Stderr)
			}
			t.Fatal(e)
		}
		var out object
		for _, line := range bytes.Split(b, []byte("\n")) {
			var candidate object
			if json.Unmarshal(line, &candidate) == nil && candidate != nil {
				out = candidate
			}
		}
		if out == nil {
			t.Fatal("original fixture JSON result missing")
		}
		return out
	}
	auth := node(filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), "setup", nil)
	script := filepath.Join(root, "go/internal/operationsresources/testdata/interop.mjs")
	oracle := func(mode string, input object) object { t.Helper(); return node(script, mode, input, path) }
	fixture := oracle("setup", nil)
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
	clock := func() time.Time { return time.Unix(int64(fixture["clock"].(float64)), 0) }
	endpoint, issuer := str(auth["endpoint"]), str(auth["issuer"])
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: str(obj(auth["ids"])["root"]), Issuer: issuer, Subject: "root"}}, directory{})
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = clock
	devices := &deviceauth.Service{Pool: pool, Endpoint: endpoint, Now: clock}
	caseService := &cases.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: clock}
	capsuleService := &capsules.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Cases: caseService, Records: &verificationrecords.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Cases: caseService, Now: clock}, Configurations: &configurations.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: clock}, Now: clock}
	projectService := &projects.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: clock}
	service := &res.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, PrincipalWithin: gateway.LockOperationsPrincipalWithin, Projects: projectService, Capsules: capsuleService, MaxHideSeconds: 86400, Now: clock}
	server := httptest.NewServer(res.Handler{Service: service})
	defer server.Close()
	request := func(who, method, path string, input object, csrf bool) (int, object) {
		t.Helper()
		var b io.Reader
		if input != nil {
			b = bytes.NewReader(enc(input))
		}
		r, e := http.NewRequest(method, server.URL+path, b)
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat(map[string]string{"root": "R", "writer": "W", "empty": "E"}[who], 43)})
		if csrf {
			r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		}
		response, e := server.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		var out object
		if e = json.NewDecoder(response.Body).Decode(&out); e != nil {
			t.Fatal(e)
		}
		return response.StatusCode, out
	}
	call := func(method, path string, input object) object {
		t.Helper()
		status, out := request("root", method, path, input, true)
		if status != 200 {
			t.Fatalf("HTTP%d %s %v", status, path, out)
		}
		return out
	}
	base := "/v1/operations/resources/"
	if status, _ := request("empty", "GET", base+"projects", nil, false); status != 403 {
		t.Fatal("no resource permission", status)
	}
	for _, kind := range []string{"projects", "methods"} {
		if methodsOnly && kind == "projects" {
			continue
		}
		id := str(obj(fixture["project"])["projectId"])
		if kind == "methods" {
			id = str(obj(fixture["capsule"])["capsuleId"])
		}
		get := func() {
			t.Helper()
			equal(t, call("GET", base+kind+"/"+id, nil), oracle("get", object{"kind": kind, "id": id}))
			equal(t, call("GET", base+kind, nil), oracle("list", object{"kind": kind}))
		}
		get()
		hide := object{"operationId": uuid.NewString(), "kind": "hide", "expectedVersion": 1, "expectedVisibilityVersion": 0, "until": clock().Unix() + 300, "reason": " 原运营限时隐藏 "}
		if status, _ := request("root", "POST", base+kind+"/"+id+"/visibility", hide, false); status == 200 {
			t.Fatal("missing CSRF accepted")
		}
		actual := call("POST", base+kind+"/"+id+"/visibility", hide)
		expected := oracle("visibility", object{"kind": kind, "id": id, "input": hide})
		if expected["replayed"] != true {
			t.Fatal("original operation not replayed")
		}
		delete(expected, "replayed")
		equal(t, actual, expected)
		get()
		equal(t, call("GET", base+kind+"/"+id+"/operations/"+str(hide["operationId"]), nil), oracle("receipt", object{"kind": kind, "id": id, "operationId": hide["operationId"]}))
		version := 2
		if kind == "methods" {
			oracle("private-method", nil)
			version = 3
		} else {
			oracle("private-project", nil)
		}
		get()
		restore := object{"operationId": uuid.NewString(), "kind": "restore", "expectedVersion": version, "expectedVisibilityVersion": 1, "reason": " 只移除运营隐藏 "}
		actual = call("POST", base+kind+"/"+id+"/visibility", restore)
		expected = oracle("visibility", object{"kind": kind, "id": id, "input": restore})
		delete(expected, "replayed")
		equal(t, actual, expected)
		get()
		view := call("GET", base+kind+"/"+id, nil)
		if view["sourceState"] != "unavailable" || view["publicContent"] != nil || obj(view["visibility"])["hidden"] != false {
			t.Fatal("restore granted private source", view)
		}
		if kind == "methods" {
			if view["deprecated"] != true {
				t.Fatal("private latest lost independent maintenance", view)
			}
		} else {
			oracle("archive-project", nil)
			get()
		}
		bad := object{"operationId": uuid.NewString(), "kind": "hide", "expectedVersion": 3, "expectedVisibilityVersion": 2, "until": clock().Unix() + 400, "reason": " 不恢复失效来源 "}
		status, out := request("root", "POST", base+kind+"/"+id+"/visibility", bad, true)
		if status != 409 || out["error"] != "operations_source_unavailable" {
			t.Fatal("unavailable source hide", status, out)
		}
	}
}
