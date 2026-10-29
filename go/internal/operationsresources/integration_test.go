package operationsresources_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	res "github.com/agigalaxy-team/agigalaxy/go/internal/operationsresources"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		t.Fatalf("boundary/domain differed\nHTTP%s\nGo%s\n%v %v", x, y, e, f)
	}
}

func TestResourcePublicSourceVisibilityAndPrivateLatestMaintenance(t *testing.T) {
	testResources(t, false)
}
func TestMethodPrivateLatestMaintenanceOnly(t *testing.T) { testResources(t, true) }
func testResources(t *testing.T, methodsOnly bool) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := newResourcesFixture(t, owner)
	fixture := f.Data
	clock := f.Management.Now
	service := &res.Service{Pool: f.Management.Pool, Endpoint: f.Management.Endpoint, Authority: f.Management.Gateway, PrincipalWithin: f.Management.Gateway.LockOperationsPrincipalWithin, Projects: f.Projects, Capsules: f.Capsules, MaxHideSeconds: 86400, Now: clock}
	reference := *service
	current := func(mode string, input object) object {
		t.Helper()
		var out object
		var err error
		kind, id := str(input["kind"]), str(input["id"])
		switch mode {
		case "list":
			out, err = reference.List(ctx, f.Management.Root, kind, object{})
		case "get":
			out, err = reference.Get(ctx, f.Management.Root, kind, id)
		case "visibility":
			out, err = reference.Visibility(ctx, f.Management.Root, kind, id, obj(input["input"]))
		case "receipt":
			out, err = reference.CommandResult(ctx, f.Management.Root, kind, id, str(input["operationId"]))
		default:
			f.Change(t, mode)
			return object{}
		}
		if err != nil {
			t.Fatalf("current Go %s: %v", mode, err)
		}
		return out
	}
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
			equal(t, call("GET", base+kind+"/"+id, nil), current("get", object{"kind": kind, "id": id}))
			equal(t, call("GET", base+kind, nil), current("list", object{"kind": kind}))
		}
		get()
		hide := object{"operationId": uuid.NewString(), "kind": "hide", "expectedVersion": 1, "expectedVisibilityVersion": 0, "until": clock().Unix() + 300, "reason": " 原运营限时隐藏 "}
		if status, _ := request("root", "POST", base+kind+"/"+id+"/visibility", hide, false); status == 200 {
			t.Fatal("missing CSRF accepted")
		}
		actual := call("POST", base+kind+"/"+id+"/visibility", hide)
		expected := current("visibility", object{"kind": kind, "id": id, "input": hide})
		if expected["replayed"] != true {
			t.Fatal("current Go operation not replayed")
		}
		delete(expected, "replayed")
		equal(t, actual, expected)
		get()
		equal(t, call("GET", base+kind+"/"+id+"/operations/"+str(hide["operationId"]), nil), current("receipt", object{"kind": kind, "id": id, "operationId": hide["operationId"]}))
		version := 2
		if kind == "methods" {
			current("private-method", nil)
			version = 3
		} else {
			current("private-project", nil)
		}
		get()
		restore := object{"operationId": uuid.NewString(), "kind": "restore", "expectedVersion": version, "expectedVisibilityVersion": 1, "reason": " 只移除运营隐藏 "}
		actual = call("POST", base+kind+"/"+id+"/visibility", restore)
		expected = current("visibility", object{"kind": kind, "id": id, "input": restore})
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
			current("archive-project", nil)
			get()
		}
		bad := object{"operationId": uuid.NewString(), "kind": "hide", "expectedVersion": 3, "expectedVisibilityVersion": 2, "until": clock().Unix() + 400, "reason": " 不恢复失效来源 "}
		status, out := request("root", "POST", base+kind+"/"+id+"/visibility", bad, true)
		if status != 409 || out["error"] != "operations_source_unavailable" {
			t.Fatal("unavailable source hide", status, out)
		}
	}
}
