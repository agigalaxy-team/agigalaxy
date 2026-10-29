package operationsqueries

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type directory struct{}
type publicationFixtureAuthority struct{}

func (publicationFixtureAuthority) Account(context.Context, pgx.Tx, string, string) error { return nil }

func (directory) Roles(context.Context, string, string) ([]string, error) {
	return []string{"admit-admin"}, nil
}
func (d directory) RolesFresh(ctx context.Context, i, s string) ([]string, error) {
	return d.Roles(ctx, i, s)
}
func encoded(v any) string { b, _ := json.Marshal(v); return string(b) }
func TestActualMessagingQueriesCurrentHumanAIAndOriginalProjection(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	endpoint, issuer, rootID := f.Endpoint, f.Issuer, f.IDs["root"]
	fixture := seedQueryMessaging(t, f)
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: rootID, Issuer: issuer, Subject: "root"}}, directory{})
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	permissions := &operationspermissions.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway, Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	r := httptest.NewRequest("GET", "https://admin.example.invalid/v1/operations/agentos", nil)
	r.Header.Set("Origin", "https://admin.example.invalid")
	r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	actor, e := gateway.AuthorizeOperations(r, false, "workbench.read")
	if e != nil {
		t.Fatal(e)
	}
	source := &messaging.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now}
	audit := &operationsaudit.Service{Domain: &businessadmin.Domain{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now}}
	defer audit.Close()
	queries := &Service{Pool: pool, Permissions: permissions, Messaging: source, Audit: audit, Now: now}
	planID := str(object(fixture["created"])["planId"])
	if planID == "" {
		planID = str(object(object(fixture["created"])["plan"])["id"])
	}
	if _, e = queries.Query(ctx, actor, "messaging", "query-operations", Object{"module": "audit", "view": "list", "filters": Object{"kind": "reads", "limit": 1}}); e != nil {
		t.Fatal(e)
	}
	requests := []Object{{"module": "messaging", "view": "plans"}, {"module": "messaging", "view": "history", "filters": Object{"planId": planID}}, {"module": "messaging", "view": "runs"}, {"kind": "message-plan", "id": planID}, {"module": "audit", "view": "list", "filters": Object{"kind": "business", "limit": 3}}}
	var draftRefs []Object
	for index, input := range requests {
		tool := "query-operations"
		if input["kind"] != nil {
			tool = "read-operation-object"
		}
		result, e := queries.Query(ctx, actor, "messaging", tool, input)
		if e != nil {
			t.Fatal(e)
		}
		if result["tool"] != tool || result["availability"] != "available" || result["data"] == nil || object(result["pagination"])["complete"] == nil {
			t.Fatalf("typed query envelope: %s", encoded(result))
		}
		if index == 4 && (object(result["pagination"])["complete"] != false || object(result["pagination"])["next"] == nil) {
			t.Fatalf("audit pagination did not expose continuation: %s", encoded(result))
		}
		if tool == "query-operations" && strings.Contains(encoded(result), "Untrusted selected") {
			t.Fatal("directory copied private draft body")
		}
		if tool == "read-operation-object" && !strings.Contains(encoded(result), "Untrusted selected") {
			t.Fatal("selected draft material was omitted")
		}
		if tool == "read-operation-object" {
			for _, value := range result["evidenceRefs"].([]any) {
				ref := object(value)
				if ref["controlledSource"] == true {
					draftRefs = append(draftRefs, ref)
				}
			}
		}
	}
	// Publication's account check is a fixture double. The workbench query below
	// uses the actual management cookie, opaque query proof and current source
	// permission/audience/governance reader, without external identity calls.
	publicFixture := seedQueryPublication(t, f)
	forum := &community.Service{Pool: pool, Endpoint: endpoint, Authority: publicationFixtureAuthority{}, Now: now, OperationsHandling: true}
	if _, e = forum.Publish(ctx, str(publicFixture["accounts"].([]any)[0]), encoded(publicFixture["payload"])); e != nil {
		t.Fatal("public activity fixture publication", e)
	}
	workbench := &Workbench{Domain: &businessadmin.Domain{Pool: pool, Endpoint: endpoint, Authority: gateway, PrincipalWithin: gateway.LockOperationsPrincipalWithin, Now: now}, Forum: forum}
	queries.Workbench = workbench
	queryActor, e := queries.human(ctx, actor, "messaging", "workbench.read")
	if e != nil {
		t.Fatal(e)
	}
	for _, options := range []Object{{}, {"publicActivity": "deferred"}} {
		result, e := workbench.SummaryWithAuthority(ctx, queryActor, options, permissions.QueryReader())
		if e != nil {
			t.Fatal(e)
		}
		if result["files"] != nil || object(result["availability"])["files"] != "unavailable" {
			t.Fatal("unavailable file source was reported as zero")
		}
		if len(options) == 0 {
			posts, _ := number(object(object(result["businessActivity"])["totals"])["posts"])
			if posts != 1 {
				t.Fatalf("qualified current publication was not counted %s", encoded(result))
			}
		}
	}
	var permissionID string
	if e = owner.QueryRow(ctx, "SELECT permission_id::text FROM forum_versions_v1 WHERE id=$1", object(publicFixture["payload"])["versionId"]).Scan(&permissionID); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=$2 WHERE id=$1", permissionID, now()); e != nil {
		t.Fatal(e)
	}
	changed, e := workbench.SummaryWithAuthority(ctx, queryActor, Object{}, permissions.QueryReader())
	if e != nil {
		t.Fatal(e)
	}
	posts, _ := number(object(object(changed["businessActivity"])["totals"])["posts"])
	if posts != 0 {
		t.Fatal("revoked publication stayed in real workbench activity")
	}
	currentSummary, e := queries.WorkbenchSummary(ctx, queryActor)
	if e != nil || object(currentSummary["availability"])["businessActivity"] != "not-requested" {
		t.Fatalf("conversation callback did not use deferred source %v %s", e, encoded(currentSummary))
	}
	handler := WorkbenchHandler{Workbench: workbench, Authority: gateway}
	for _, query := range []string{"publicActivity=deferred", "publicActivity=deferred&publicActivity=deferred"} {
		req := r.Clone(ctx)
		req.URL.Path, req.URL.RawQuery = "/v1/operations/summary", query
		response := httptest.NewRecorder()
		requestID := uuid.NewString()
		response.Header().Set("X-Request-ID", requestID)
		handler.ServeHTTP(response, req)
		want := 200
		if strings.Contains(query, "&") {
			want = 400
		}
		if response.Code != want || response.Header().Get("X-Request-ID") != requestID {
			t.Fatalf("summary HTTP %d %s", response.Code, response.Body.String())
		}
	}
	checked, e := queries.Revalidate(ctx, actor, "messaging", draftRefs)
	if e != nil || checked["valid"] != true {
		t.Fatalf("current draft was not re-read %v %v", checked, e)
	}
	current, e := source.Get(ctx, actor, planID)
	if e != nil {
		t.Fatal(e)
	}
	plan := object(current["plan"])
	config := object(plan["config"])
	object(config["content"])["title"] = "Changed selected draft"
	if _, e = source.Save(ctx, actor, planID, Object{"operationId": uuid.NewString(), "expectedVersion": plan["version"], "expectedRevision": plan["revision"], "config": config}); e != nil {
		t.Fatal(e)
	}
	checked, e = queries.Revalidate(ctx, actor, "messaging", draftRefs)
	if e != nil || checked["valid"] != false || len(checked["invalidRefs"].([]any)) != 1 {
		t.Fatalf("changed controlled source accepted stale ref %v %v", checked, e)
	}
	if _, e = queries.Query(ctx, Actor{ID: rootID, Role: "administrator", Endpoint: endpoint}, "messaging", "query-operations", requests[0]); e == nil {
		t.Fatal("reconstructed actor obtained a query proof")
	}
	bound, e := queries.human(ctx, actor, "messaging", "notices.read")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = queries.Query(ctx, bound, "governance", "query-operations", requests[0]); fault.Code(e) != "operations_agentos_domain_mismatch" {
		t.Fatalf("query crossed fixed domain %v", e)
	}
	duties := &operationsautonomy.Service{Pool: pool, Endpoint: endpoint, AIWork: permissions.AIWork, Now: now, Permissions: permissions}
	permissions.Duty = duties
	taskID := uuid.NewString()
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return duties.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: taskID, Domain: "messaging", AIAccountID: str(object(automation["accounts"])["messaging"])})
	}); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, "UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='messaging'", endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine',mode='ai',state='running',lease_until=$3,configuration=jsonb_set(configuration,'{plan,actions}','["notices.read"]') WHERE endpoint=$1 AND id=$2`, endpoint, taskID, time.Unix(2000000600, 0)); e != nil {
		t.Fatal(e)
	}
	duty, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) { return duties.DutyForTaskWithin(ctx, tx, taskID, "query") })
	if e != nil {
		t.Fatal(e)
	}
	humanResult, e := queries.Query(ctx, actor, "messaging", "query-operations", requests[0])
	if e != nil {
		t.Fatal(e)
	}
	dutyResult, e := queries.Query(ctx, duty, "messaging", "query-operations", requests[0])
	if e != nil || mustEqual(humanResult, dutyResult) != true {
		t.Fatalf("real current Duty source differs %v %s %s", e, encoded(humanResult), encoded(dutyResult))
	}
	if _, e = owner.Exec(ctx, "UPDATE operations_autonomy_tasks_v1 SET state='paused' WHERE id=$1", taskID); e != nil {
		t.Fatal(e)
	}
	if _, e = queries.Query(ctx, duty, "messaging", "query-operations", requests[0]); e == nil {
		t.Fatal("inactive Duty kept typed source access")
	}
	if _, e = owner.Exec(ctx, "UPDATE operations_ai_work_assignments_v1 SET enabled=false WHERE endpoint=$1 AND role_id=$2", endpoint, object(fixture["role"])["id"]); e != nil {
		t.Fatal(e)
	}
	if _, e = queries.Query(ctx, bound, "messaging", "query-operations", requests[0]); e == nil {
		t.Fatal("revoked current AI role retained read access")
	}
}
func mustEqual(a, b any) bool { return encoded(a) == encoded(b) }
