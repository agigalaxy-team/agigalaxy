package operationsautonomy_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type localRoles struct{}

func (localRoles) Roles(context.Context, string, string) ([]string, error) {
	return []string{"admit-admin"}, nil
}
func (localRoles) RolesFresh(context.Context, string, string) ([]string, error) {
	return []string{"admit-admin"}, nil
}
func TestAutonomySettingsAndDisabledConfigurationOriginalInterop(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	encode := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	node := func(script, mode string, input a.Object) a.Object {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/"+script), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		if input != nil {
			cmd.Stdin = strings.NewReader(encode(input))
		}
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original %s %v %s", mode, e, out)
		}
		var o a.Object
		if json.Unmarshal(out, &o) != nil {
			t.Fatal("invalid original result")
		}
		return o
	}
	base := node("operations-permissions-interop.mjs", "setup", nil)
	endpoint, issuer := base["endpoint"].(string), base["issuer"].(string)
	rootID := base["ids"].(map[string]any)["root"].(string)
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: rootID, Issuer: issuer, Subject: "root"}}, localRoles{})
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	request := httptest.NewRequest("POST", "https://admin.example.invalid/v1/operations/autonomy", nil)
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	actor, e := gateway.AuthorizeOperations(request, true, "autonomy.read")
	if e != nil {
		t.Fatal(e)
	}
	authorize := func(context.Context) (a.Actor, error) { return gateway.AuthorizeOperations(request, true, "") }
	service := &a.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, AIWork: &operationsai.Service{Endpoint: endpoint}, Now: now}
	original := func(method, domain string, input a.Object) a.Object {
		return node("operations-autonomy-interop.mjs", "human", a.Object{"endpoint": endpoint, "operatorId": rootID, "method": method, "domain": domain, "input": input})
	}
	eq := func(label string, v, w any) {
		t.Helper()
		normalize := func(v any) any { var o any; json.Unmarshal([]byte(encode(v)), &o); return o }
		if !reflect.DeepEqual(normalize(v), normalize(w)) {
			t.Fatalf("%s\nGo%s\nJS%s", label, encode(v), encode(w))
		}
	}
	settings, e := service.Settings(ctx, actor)
	if e != nil {
		t.Fatal(e)
	}
	eq("default settings", settings, original("settings", "", nil))
	input := a.Object{"operationId": uuid.NewString(), "expectedRevision": 1, "concurrency": 1, "healthSeconds": 60, "startGraceSeconds": 90, "roundSeconds": 300, "eventCoalesceSeconds": 10}
	saved, e := service.SaveSettings(ctx, actor, input, authorize)
	if e != nil {
		t.Fatal(e)
	}
	js := original("saveSettings", "", input)
	js["replayed"] = false
	eq("settings original-ID JS recovery", saved, js)
	first, e := service.GetConfig(ctx, actor, "overview")
	if e != nil {
		t.Fatal(e)
	}
	eq("current config/readiness", first, original("getConfig", "overview", nil))
	configuration := a.Object{"operationId": uuid.NewString(), "expectedRevision": 1, "enabled": false, "mode": "ai-human", "schedule": a.Object{"kind": "interval", "minutes": 45}, "purpose": " original purpose ", "goal": strings.Repeat("😀", 4000), "prompt": strings.Repeat("😀", 16000), "plan": a.Object{}}
	saved, e = service.SaveConfig(ctx, actor, "overview", configuration, authorize)
	if e != nil {
		t.Fatal(e)
	}
	js = original("saveConfig", "overview", configuration)
	js["replayed"] = false
	eq("disabled config original-ID JS recovery", saved, js)
	current, e := service.GetConfig(ctx, actor, "overview")
	if e != nil {
		t.Fatal(e)
	}
	eq("config and version history", current, original("getConfig", "overview", nil))
	if _, e = service.Enable(ctx, actor, a.Object{"operationId": uuid.NewString(), "accounts": []any{a.Object{"domain": "overview", "expectedRevision": 2}}}, authorize); fault.Code(e) != "operations_autonomy_not_ready" {
		t.Fatalf("unavailable runtime enabled %v", e)
	}
	daily := a.Object{"kind": "daily", "at": "00:00", "timezone": "Asia/Shanghai"}
	due, e := a.NextDue(daily, time.Date(2026, 10, 28, 15, 59, 0, 0, time.UTC))
	if e != nil || !due.Equal(time.Date(2026, 10, 28, 16, 0, 0, 0, time.UTC)) {
		t.Fatalf("daily due %v %v", due, e)
	}
	due, e = a.NextDue(daily, time.Date(2026, 10, 28, 16, 0, 0, 0, time.UTC))
	if e != nil || !due.Equal(time.Date(2026, 10, 29, 16, 0, 0, 0, time.UTC)) {
		t.Fatalf("daily next day %v %v", due, e)
	}
	var enabled int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND enabled`, endpoint).Scan(&enabled); e != nil || enabled != 0 {
		t.Fatalf("unexpected enabled plans %d %v", enabled, e)
	}
	options, e := service.Options(ctx, actor)
	if e != nil {
		t.Fatal(e)
	}
	eq("closed current options", options, original("options", "", nil))
	// An already enabled original plan can accept one manual intent even when
	// its runtime is currently unavailable; dispatch will enforce current readiness.
	admin, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer admin.Close()
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true,configuration=jsonb_set(configuration,'{enabled}','true') WHERE endpoint=$1 AND domain='overview'`, endpoint); e != nil {
		t.Fatal(e)
	}
	taskID := uuid.NewString()
	runInput := a.Object{"operationId": taskID}
	run, e := service.Run(ctx, actor, "overview", runInput, authorize)
	if e != nil {
		t.Fatal(e)
	}
	js = original("run", "overview", runInput)
	js["replayed"] = false
	eq("manual original task", run, js)
	task, e := service.GetTask(ctx, actor, taskID)
	if e != nil {
		t.Fatal(e)
	}
	eq("task view", task, original("getTask", "", a.Object{"id": taskID}))
	tasks, e := service.Tasks(ctx, actor, a.Object{})
	if e != nil {
		t.Fatal(e)
	}
	eq("task page", tasks, original("tasks", "", a.Object{}))
	overview, e := service.Overview(ctx, actor, 7)
	if e != nil {
		t.Fatal(e)
	}
	eq("persisted-only overview", overview, original("overview", "", a.Object{"days": 7}))
	revision := task["task"].(map[string]any)["revision"]
	pause := a.Object{"operationId": uuid.NewString(), "expectedRevision": revision, "kind": "pause"}
	paused, e := service.Control(ctx, actor, taskID, pause, authorize)
	if e != nil {
		t.Fatal(e)
	}
	js = original("control", "", a.Object{"id": taskID, "command": pause})
	js["replayed"] = false
	eq("pause original receipt", paused, js)
	receipt, e := service.Operation(ctx, actor, pause["operationId"].(string))
	if e != nil {
		t.Fatal(e)
	}
	eq("owned original command receipt", receipt, original("operation", "", a.Object{"id": pause["operationId"]}))
}
