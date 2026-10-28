package operationsmodels

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
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
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type currentDirectory struct{ enabled *atomic.Bool }

func (d currentDirectory) Roles(ctx context.Context, i, s string) ([]string, error) {
	return d.RolesFresh(ctx, i, s)
}
func (d currentDirectory) RolesFresh(context.Context, string, string) ([]string, error) {
	if d.enabled.Load() {
		return []string{"admit-admin"}, nil
	}
	return []string{}, nil
}

type modelTransport struct{ handle http.Handler }

func (t modelTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	w := httptest.NewRecorder()
	r.RemoteAddr = "127.0.0.1:30123"
	t.handle.ServeHTTP(w, r)
	return w.Result(), nil
}
func TestModelsRealAPIProtectedNativeAndOriginalPG(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs("../../..")
	node := func(mode string, input Object) Object {
		t.Helper()
		b, _ := json.Marshal(input)
		c := exec.Command("node", filepath.Join(root, "scripts/go/models-interop.mjs"), mode)
		c.Dir = root
		c.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		c.Stdin = strings.NewReader(string(b))
		raw, e := c.CombinedOutput()
		if e != nil {
			t.Fatalf("source %s %v %s", mode, e, raw)
		}
		var o Object
		if json.Unmarshal(raw, &o) != nil {
			t.Fatal("source reply")
		}
		return o
	}
	base := node("setup", Object{})
	now := func() time.Time { return time.Unix(2000000000, 0) }
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	var enabled atomic.Bool
	enabled.Store(true)
	g, e := access.New(pool, access.Config{Endpoint: str(base["endpoint"]), WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", OperatorIssuer: str(base["issuer"]), AccountIssuer: "https://website.example.invalid/realms/website", AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{Issuer: str(base["issuer"]), Subject: "root", OperatorID: str(base["operatorId"])}}, currentDirectory{&enabled})
	if e != nil {
		t.Fatal(e)
	}
	g.Now = now
	configuration, _ := ParseConfiguration(sampleConfiguration())
	model := obj(list(configuration["models"])[0])
	modelID := str(model["id"])
	key := strings.Repeat("k", 40)
	status := sampleStatus()
	status["credentials"] = []any{}
	var handler Handler
	var shared *maintenance.Client
	var posts, gets atomic.Int32
	var nativeMu sync.Mutex
	operations := map[string]Object{}
	applyID := ""
	complete := false
	badReadback := false
	shared = maintenance.New(maintenance.Configuration{SocketPath: "/run/galaxy-maintenance/api.sock", Key: key}, maintenance.Options{Now: now, Transport: modelTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nativeMu.Lock()
		defer nativeMu.Unlock()
		proof, e := shared.VerifyService(r)
		raw, _ := io.ReadAll(r.Body)
		if e == nil {
			e = shared.VerifyBody(proof, raw)
		}
		if e != nil {
			respond(w, nil, e)
			return
		}
		if r.URL.Path != "/v1/model-settings" {
			t.Error("unexpected model transport path")
			return
		}
		var input Object
		_ = json.Unmarshal(raw, &input)
		kind := str(input["kind"])
		var out Object
		switch kind {
		case "models-overview":
			out = status
		case "models-usage":
			out = Object{"availability": Object{"state": "available"}, "days": input["days"], "calls": Object{"total": 2, "completed": 1, "failed": 0, "unknown": 1}, "tokens": Object{"input": 42, "output": nil, "total": nil, "cachedInput": 0, "reasoning": nil}, "unknownUsageCalls": 1, "byScenario": []any{}, "byModel": []any{}}
		case "models-operation":
			gets.Add(1)
			id := str(input["operationId"])
			out = clone(operations[id])
			if id == applyID && complete {
				out["state"] = "completed"
				status["appliedVersionId"] = out["versionId"]
				if badReadback {
					obj(obj(status["engines"])["gateway"])["configurationVersion"] = "wrong"
				} else {
					obj(obj(status["engines"])["gateway"])["configurationVersion"] = "original-v1"
				}
			}
		case "models-credential-provision", "models-apply":
			posts.Add(1)
			auth := clone(input)
			delete(auth, "apiKey")
			authBytes, _ := json.Marshal(auth)
			req := httptest.NewRequest("POST", "http://api.invalid/v1/internal/models/authorize", strings.NewReader(string(authBytes)))
			req.RemoteAddr = "127.0.0.1:9001"
			id, at := uuid.NewString(), "2000000000"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Galaxy-Service-Key", key)
			req.Header.Set("X-Galaxy-Request-Id", id)
			req.Header.Set("X-Galaxy-Request-At", at)
			req.Header.Set("X-Galaxy-Service-Signature", maintenance.Signature(key, id, at, authBytes))
			reply := httptest.NewRecorder()
			handler.ServeHTTP(reply, req)
			if reply.Code != 200 {
				t.Errorf("private model authority %d %s", reply.Code, reply.Body.String())
				respond(w, nil, fail("model_settings_permission_denied", 403))
				return
			}
			opID := str(input["operationId"])
			out = Object{"id": opID, "kind": kind, "state": "completed", "code": nil, "startedAt": nil, "finishedAt": nil}
			if kind == "models-credential-provision" {
				if input["apiKey"] != "isolated-provider-secret" {
					t.Error("changed opaque secret")
				}
				ref := "model-key:" + opID
				out["credentialRef"] = ref
				status["credentials"] = []any{Object{"reference": ref, "modelRecordId": modelID, "configured": true}}
			} else {
				applyID = opID
				out["state"] = "unknown"
				out["versionId"] = input["versionId"]
			}
			operations[opID] = out
			if kind == "models-apply" {
				respond(w, nil, fail("model_settings_native_unavailable", 503))
				return
			}
		default:
			t.Errorf("unknown native call %s", kind)
		}
		respond(w, out, nil)
	})}})
	native := &NativeClient{Client: shared}
	service := &Service{Pool: pool, Endpoint: str(base["endpoint"]), Authority: g, StoredAuthority: g.StoredOperators(), Native: native, Now: now}
	handler = Handler{Service: service, Native: native}
	call := func(method, path string, input Object, authenticated bool) (int, Object) {
		t.Helper()
		raw, _ := json.Marshal(input)
		req := httptest.NewRequest(method, "http://api.invalid/v1/operations/model-settings"+path, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		if authenticated {
			req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	if code, _ := call("GET", "/overview", nil, false); code != 401 {
		t.Fatalf("unauth models %d", code)
	}
	credential := Object{"operationId": uuid.NewString(), "modelRecordId": modelID, "apiKey": "isolated-provider-secret"}
	code, credentialResult := call("POST", "/credentials", credential, true)
	if code != 200 || credentialResult["phase"] != "applied" {
		t.Fatalf("credential %d %#v", code, credentialResult)
	}
	model["credentialRef"] = credentialResult["credentialRef"]
	draft := Object{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": configuration, "reason": "原人工模型配置"}
	code, draftResult := call("POST", "/draft", draft, true)
	if code != 200 || draftResult["phase"] != "applied" {
		t.Fatalf("draft %d %#v", code, draftResult)
	}
	sourceReplay := node("draft", Object{"input": draft})
	if sourceReplay["replayed"] != true {
		t.Fatal("original JS cannot replay Go canonical request hash")
	}
	code, view := call("GET", "/overview", nil, true)
	source := node("overview", Object{"native": status})
	if code != 200 || !same(view, source) {
		a, _ := json.Marshal(view)
		b, _ := json.Marshal(source)
		t.Fatalf("overview mismatch %d\nGo%s\nJS%s", code, a, b)
	}
	code, history := call("GET", "/history", nil, true)
	source = node("history", Object{})
	if code != 200 || !same(history, source) {
		a, _ := json.Marshal(history)
		b, _ := json.Marshal(source)
		t.Fatalf("history mismatch %d\nGo%s\nJS%s", code, a, b)
	}
	apply := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "versionId": draftResult["versionId"], "reason": "原人工应用"}
	code, out := call("POST", "/apply", apply, true)
	if code != 200 || out["phase"] != "result-unknown" {
		t.Fatalf("unknown apply %d %#v", code, out)
	}
	code, out = call("POST", "/apply", apply, true)
	if code != 200 || out["phase"] != "result-unknown" || posts.Load() != 2 {
		t.Fatalf("unknown resubmission %d %#v post%d", code, out, posts.Load())
	}
	complete, badReadback = true, true
	code, out = call("GET", "/operations/"+applyID, nil, true)
	if code != 200 || out["phase"] != "result-unknown" || out["errorCode"] != "model_settings_native_readback_mismatch" {
		t.Fatalf("readback mismatch applied %d %#v", code, out)
	}
	badReadback = false
	code, out = call("GET", "/operations/"+applyID, nil, true)
	if code != 200 || out["phase"] != "applied" || posts.Load() != 2 {
		t.Fatalf("original operation recovery %d %#v post%d", code, out, posts.Load())
	}
	code, usage := call("GET", "/usage?days=7", nil, true)
	if code != 200 || obj(usage["tokens"])["output"] != nil || obj(usage["calls"])["unknown"] != float64(1) {
		t.Fatalf("unknown token projection %d %#v", code, usage)
	}
	sourceDraft := node("draft", Object{"input": Object{"operationId": uuid.NewString(), "expectedRevision": 3, "configuration": configuration, "reason": "原JS草稿"}})
	code, out = call("GET", "/operations/"+str(sourceDraft["operationId"]), nil, true)
	if code != 200 || out["phase"] != "applied" {
		t.Fatalf("read original operation %d %#v", code, out)
	}
	duplicate := clone(credential)
	duplicate["apiKey"] = "different-secret-ignored-on-replay"
	code, out = call("POST", "/credentials", duplicate, true)
	if code != 200 || out["replayed"] != true || posts.Load() != 2 {
		t.Fatalf("credential safe replay %d %#v", code, out)
	}
	var secrets bool
	if e = admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_model_settings_operations_v1 WHERE input::text LIKE '%isolated-provider-secret%' OR input::text LIKE '%different-secret%')`).Scan(&secrets); e != nil || secrets {
		t.Fatalf("secret persisted %v %v", secrets, e)
	}
	concurrentInput := Object{"operationId": uuid.NewString(), "modelRecordId": modelID, "apiKey": "isolated-provider-secret"}
	var group sync.WaitGroup
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			status, _ := call("POST", "/credentials", concurrentInput, true)
			if status != 200 {
				t.Errorf("concurrent original intent status %d", status)
			}
		}()
	}
	group.Wait()
	if posts.Load() != 3 {
		t.Fatalf("concurrent claim submitted %d times", posts.Load()-2)
	}
	enabled.Store(false)
	if code, _ = call("POST", "/credentials", Object{"operationId": uuid.NewString(), "modelRecordId": modelID, "apiKey": "isolated-provider-secret"}, true); code != 403 {
		t.Fatalf("withdrawn authority %d", code)
	}
	if posts.Load() != 3 {
		t.Fatal("withdrawn authority sent model mutation")
	}
	enabled.Store(true)
	if _, e = service.AuthorizeNative(ctx, Object{"kind": "models-credential-provision", "operatorId": base["operatorId"], "operationId": uuid.NewString(), "modelRecordId": modelID}); fault.Status(e) != 403 {
		t.Fatalf("unrecorded native model mutation %v", e)
	}
}
