package operationsautonomy_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
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
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	endpoint, issuer, rootID := f.Endpoint, f.Issuer, f.IDs["root"]
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
	settings, e := service.Settings(ctx, actor)
	if e != nil {
		t.Fatal(e)
	}
	if settings["settings"] == nil {
		t.Fatal("default settings unavailable")
	}
	input := a.Object{"operationId": uuid.NewString(), "expectedRevision": 1, "concurrency": 1, "healthSeconds": 60, "startGraceSeconds": 90, "roundSeconds": 300, "eventCoalesceSeconds": 10}
	saved, e := service.SaveSettings(ctx, actor, input, authorize)
	if e != nil {
		t.Fatal(e)
	}
	if saved["settings"] == nil {
		t.Fatal("settings write missing")
	}
	replay, e := service.SaveSettings(ctx, actor, input, authorize)
	if e != nil || replay["replayed"] != true {
		t.Fatal("settings receipt replay", e)
	}
	first, e := service.GetConfig(ctx, actor, "overview")
	if e != nil {
		t.Fatal(e)
	}
	if first["config"] == nil || first["readiness"] == nil {
		t.Fatal("initial configuration missing")
	}
	configuration := a.Object{"operationId": uuid.NewString(), "expectedRevision": 1, "enabled": false, "mode": "ai-human", "schedule": a.Object{"kind": "interval", "minutes": 45}, "purpose": " original purpose ", "goal": strings.Repeat("😀", 4000), "prompt": strings.Repeat("😀", 16000), "plan": a.Object{}}
	saved, e = service.SaveConfig(ctx, actor, "overview", configuration, authorize)
	if e != nil {
		t.Fatal(e)
	}
	if saved["config"] == nil {
		t.Fatal("saved configuration missing")
	}
	replay, e = service.SaveConfig(ctx, actor, "overview", configuration, authorize)
	if e != nil || replay["replayed"] != true {
		t.Fatal("configuration receipt replay", e)
	}
	current, e := service.GetConfig(ctx, actor, "overview")
	if e != nil {
		t.Fatal(e)
	}
	if current["config"] == nil || current["history"] == nil {
		t.Fatal("current configuration/history missing")
	}
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
	if options == nil {
		t.Fatal("current options missing")
	}
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
	if run["task"] == nil {
		t.Fatal("manual task missing")
	}
	replay, e = service.Run(ctx, actor, "overview", runInput, authorize)
	if e != nil || replay["replayed"] != true {
		t.Fatal("manual task replay", e)
	}
	task, e := service.GetTask(ctx, actor, taskID)
	if e != nil {
		t.Fatal(e)
	}
	if task["task"].(map[string]any)["id"] != taskID {
		t.Fatal("task readback changed")
	}
	tasks, e := service.Tasks(ctx, actor, a.Object{})
	if e != nil {
		t.Fatal(e)
	}
	if tasks["items"] == nil {
		t.Fatal("task page missing")
	}
	overview, e := service.Overview(ctx, actor, 7)
	if e != nil {
		t.Fatal(e)
	}
	if overview == nil {
		t.Fatal("persisted overview missing")
	}
	revision := task["task"].(map[string]any)["revision"]
	pause := a.Object{"operationId": uuid.NewString(), "expectedRevision": revision, "kind": "pause"}
	paused, e := service.Control(ctx, actor, taskID, pause, authorize)
	if e != nil {
		t.Fatal(e)
	}
	if paused["task"] == nil {
		t.Fatal("pause result missing")
	}
	replay, e = service.Control(ctx, actor, taskID, pause, authorize)
	if e != nil || replay["replayed"] != true {
		t.Fatal("pause receipt replay", e)
	}
	receipt, e := service.Operation(ctx, actor, pause["operationId"].(string))
	if e != nil {
		t.Fatal(e)
	}
	if receipt["state"] != "recorded" || receipt["operationId"] != pause["operationId"] {
		t.Fatal("owned command receipt missing", receipt)
	}
}
