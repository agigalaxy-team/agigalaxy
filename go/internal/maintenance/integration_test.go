package maintenance

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
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

type maintenanceTransport struct{ handle http.Handler }

func (t maintenanceTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	w := httptest.NewRecorder()
	r.RemoteAddr = "127.0.0.1:30123"
	t.handle.ServeHTTP(w, r)
	return w.Result(), nil
}
func TestMaintenanceRealAPIIntentPlanAndUnknownRecovery(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs("../../..")
	node := func(mode string, input Object) Object {
		t.Helper()
		b, _ := json.Marshal(input)
		c := exec.Command("node", filepath.Join(root, "scripts/go/maintenance-interop.mjs"), mode)
		c.Dir = root
		c.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		c.Stdin = strings.NewReader(string(b))
		raw, e := c.CombinedOutput()
		if e != nil {
			t.Fatalf("original %s %v %s", mode, e, raw)
		}
		var out Object
		if json.Unmarshal(raw, &out) != nil {
			t.Fatal("source reply")
		}
		return out
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
	hash := strings.Repeat("a", 64)
	coverage := []any{}
	for _, id := range ModuleIDs() {
		coverage = append(coverage, Object{"id": id, "state": "covered", "method": "pgbackrest-cluster", "reasonCodes": []any{}})
	}
	point := Object{"id": hash, "createdAt": "2033-05-18T03:30:00.000Z", "integrity": Object{"state": "verified"}, "coverage": coverage}
	preview := Object{"point": point, "moduleIds": ModuleIDs(), "blockers": []any{}, "productionExecutable": true, "footprintDigest": strings.Repeat("c", 64), "adapterVersion": "original-adapter-v1"}
	var posts, gets atomic.Int32
	var dropped atomic.Bool
	dropped.Store(true)
	var native *NativeClient
	var shared *Client
	var apiHandler http.Handler
	service := &Service{Pool: pool, Endpoint: str(base["endpoint"]), Authority: g, StoredAuthority: g.StoredOperators(), Now: now}
	shared = New(Configuration{SocketPath: "/run/galaxy-maintenance/api.sock", Key: strings.Repeat("k", 40)}, Options{Now: now, Transport: maintenanceTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/internal/") {
			apiHandler.ServeHTTP(w, r)
			return
		}
		proof, e := native.VerifyService(r)
		raw, _ := io.ReadAll(r.Body)
		if e == nil {
			e = native.VerifyBody(proof, raw)
		}
		if e != nil {
			respond(w, nil, e)
			return
		}
		var input Object
		_ = json.Unmarshal(raw, &input)
		kind := str(input["kind"])
		var out Object
		switch kind {
		case "restore-preview":
			out = preview
		case "backup-create", "backup-verify", "restore-execute":
			posts.Add(1)
			auth := Object{"kind": kind, "operationId": input["operationId"], "operatorId": input["operatorId"]}
			for _, k := range []string{"planId", "revision", "planDigest", "approvedAt", "pointId", "moduleIds", "openingConditions", "footprintDigest"} {
				if v, ok := input[k]; ok {
					auth[k] = v
				}
			}
			authBytes, _ := json.Marshal(auth)
			_, authStatus, authError := shared.call(ctx, "/v1/internal/maintenance/authorize", authBytes, 65536, time.Second)
			if authError != nil || authStatus != 200 {
				if authError == nil {
					authError = fault.New("maintenance_execution_not_authorized", authStatus)
				}
				respond(w, nil, authError)
				return
			}
			if dropped.Swap(false) {
				respond(w, nil, unavailable())
				return
			}
			out = Object{"id": input["operationId"], "kind": kind, "state": "succeeded", "planState": "completed", "publicActivation": true}
		case "operation":
			gets.Add(1)
			out = Object{"id": input["operationId"], "state": "not-recorded"}
		case "overview":
			out = Object{}
		default:
			out = Object{}
		}
		respond(w, out, nil)
	})}})
	native = &NativeClient{Client: shared}
	service.Native = native
	handler := Handler{Service: service, Native: native}
	apiHandler = handler
	call := func(method, path string, input Object, authenticated bool) (int, Object) {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest(method, "http://api.invalid/v1/operations/maintenance"+path, strings.NewReader(string(raw)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		if authenticated {
			r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var o Object
		_ = json.Unmarshal(w.Body.Bytes(), &o)
		return w.Code, o
	}
	if status, _ := call("GET", "/overview", nil, false); status != 401 {
		t.Fatalf("unauth status %d", status)
	}
	backup := Object{"operationId": uuid.NewString(), "kind": "create"}
	if status, _ := call("POST", "/backups", backup, true); status != 503 {
		t.Fatalf("lost ack status %d", status)
	}
	if status, out := call("POST", "/backups", backup, true); status != 200 || obj(out["operation"])["state"] != "unknown" {
		t.Fatalf("unknown retry %d %#v", status, out)
	}
	if posts.Load() != 1 || gets.Load() != 1 {
		t.Fatalf("resent accepted intent POST%d GET%d", posts.Load(), gets.Load())
	}
	create := Object{"operationId": uuid.NewString(), "pointId": hash}
	status, created := call("POST", "/restore-plans", create, true)
	if status != 200 || created["state"] != "awaiting-approval" {
		t.Fatalf("create %d %#v", status, created)
	}
	id := str(created["planId"])
	if code, _ := call("POST", "/restore-plans/"+id+"/cancel", Object{"operationId": uuid.NewString(), "expectedRevision": 99}, true); code != 409 {
		t.Fatalf("CAS accepted %d", code)
	}
	// Original JS reads Go rows, including immutable plan and event history.
	status, goView := call("GET", "/restore-plans/"+id, nil, true)
	source := node("plan", Object{"id": id})
	if status != 200 || !sameValues(goView, source) {
		a, _ := json.Marshal(goView)
		b, _ := json.Marshal(source)
		t.Fatalf("original plan mismatch %d\nGo%s\nJS%s", status, a, b)
	}
	var persisted []byte
	if e = admin.QueryRow(ctx, "SELECT plan FROM operations_maintenance_plans_v1 WHERE id=$1", id).Scan(&persisted); e != nil {
		t.Fatal(e)
	}
	var plan Object
	_ = json.Unmarshal(persisted, &plan)
	digest, _ := PlanDigest(plan)
	if digest != created["planDigest"] {
		t.Fatal("JSONB digest reconstruction changed original order")
	}
	ack := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "expectedPlanDigest": created["planDigest"], "acknowledgement": Object{"point": true, "scope": true, "possibleLoss": true, "openingConditions": true}}
	status, out := call("POST", "/restore-plans/"+id+"/approve", ack, true)
	if status != 200 || out["state"] != "approved" {
		t.Fatalf("approve %d %#v", status, out)
	}
	execute := Object{"operationId": uuid.NewString(), "expectedRevision": 2}
	status, out = call("POST", "/restore-plans/"+id+"/execute", execute, true)
	if status != 200 || obj(out["operation"])["state"] != "succeeded" {
		t.Fatalf("execute %d %#v", status, out)
	}
	status, out = call("POST", "/restore-plans/"+id+"/execute", execute, true)
	if status != 200 || obj(out["operation"])["state"] != "unknown" || posts.Load() != 2 {
		t.Fatalf("replay changed submit %d %#v %d", status, out, posts.Load())
	}
	original := node("createPlan", Object{"input": Object{"operationId": uuid.NewString(), "pointId": hash}, "preview": preview})
	originalID := str(original["planId"])
	var rawPlan []byte
	_ = admin.QueryRow(ctx, "SELECT plan FROM operations_maintenance_plans_v1 WHERE id=$1", originalID).Scan(&rawPlan)
	_ = json.Unmarshal(rawPlan, &plan)
	digest, _ = PlanDigest(plan)
	if digest != original["planDigest"] {
		t.Fatalf("original JS digest differs: Go%s JS%s", digest, original["planDigest"])
	}
	status, out = call("POST", "/restore-plans/"+originalID+"/cancel", Object{"operationId": uuid.NewString(), "expectedRevision": 1}, true)
	if status != 200 || out["state"] != "cancelled" {
		t.Fatalf("cancel source plan %d %#v", status, out)
	}
	preview["productionExecutable"] = false
	blockedStatus, blocked := call("POST", "/restore-plans", Object{"operationId": uuid.NewString(), "pointId": hash}, true)
	if blockedStatus != 200 || blocked["state"] != "blocked" {
		t.Fatalf("blocked plan %d %#v", blockedStatus, blocked)
	}
	blockedAck := clone(ack)
	blockedAck["operationId"] = uuid.NewString()
	blockedAck["expectedPlanDigest"] = blocked["planDigest"]
	if code, _ := call("POST", "/restore-plans/"+str(blocked["planId"])+"/approve", blockedAck, true); code != 409 {
		t.Fatalf("blocked approval %d", code)
	}
	preview["productionExecutable"] = true
	enabled.Store(false)
	if status, _ = call("POST", "/backups", Object{"operationId": uuid.NewString(), "kind": "create"}, true); status != 403 {
		t.Fatalf("withdrawn current permission %d", status)
	}
	if posts.Load() != 2 {
		t.Fatal("withdrawn permission sent native")
	}
	enabled.Store(true)
	if status, _ = call("GET", "/command-results/"+str(backup["operationId"]), nil, true); status != 200 {
		t.Fatalf("receipt status %d", status)
	}
	if _, e = service.AuthorizeNative(ctx, Object{"kind": "backup-create", "operatorId": base["operatorId"], "operationId": uuid.NewString()}); fault.Status(e) != 403 {
		t.Fatalf("unrecorded native authority %v", e)
	}
}
