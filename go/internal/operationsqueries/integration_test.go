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
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
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
	createdNotice, e := source.NoticeCreate(ctx, actor, messaging.Object{"operationId": uuid.NewString(), "content": messaging.Object{"purpose": "maintenance", "title": "Synthetic notice", "body": "Synthetic content", "audience": messaging.Object{"kind": "all-accounts"}, "expiresAt": now().Add(time.Hour).Format(time.RFC3339)}})
	if e != nil {
		t.Fatal(e)
	}
	noticeID := str(object(createdNotice["notice"])["id"])
	for _, entry := range []struct {
		tool  string
		input Object
	}{
		{"query-operations", Object{"module": "messaging", "view": "notices"}},
		{"read-operation-object", Object{"kind": "notice", "id": noticeID}},
	} {
		value, err := queries.Query(ctx, actor, "messaging", entry.tool, entry.input)
		if err != nil {
			t.Fatal(err)
		}
		data := object(value["data"])
		if data["objectType"] != "notice" || data["objectMechanism"] != "notice-state-publish-withdraw" {
			t.Fatalf("notice object metadata: %v", data)
		}
		if entry.tool == "query-operations" {
			rows := anyArray(data["items"])
			if len(rows) == 0 || object(rows[0])["objectType"] != "notice" {
				t.Fatal("notice list metadata missing")
			}
		}
	}
	// Generate a notice through the real plan execution path, then read it
	// through the same current-human/AI query service as other source data.
	tx, e := owner.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, owner, tx); e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	queue, e := jobs.New(owner, nil)
	if e != nil {
		t.Fatal(e)
	}
	source.Pool, source.Jobs, source.Approver = owner, queue, gateway
	generatedPlan, e := source.Create(ctx, actor, messaging.Object{"operationId": uuid.NewString(), "config": messaging.Object{"channels": []any{"inapp"}, "content": messaging.Object{"purpose": "service-update", "title": "Synthetic plan", "body": "Synthetic body", "expiresAt": now().Add(time.Hour).Format(time.RFC3339)}, "audience": messaging.Object{"kind": "attributes", "subjectTypes": []any{"person"}}, "schedule": messaging.Object{"kind": "immediate"}}})
	if e != nil {
		t.Fatal(e)
	}
	generatedPlanID := str(object(generatedPlan["plan"])["id"])
	activated, e := source.Action(ctx, actor, generatedPlanID, "activate", messaging.Object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 1})
	if e != nil {
		t.Fatal(e)
	}
	jobID := str(object(activated["plan"])["jobId"])
	executed, e := source.ExecutePlan(ctx, jobs.Task{ID: jobID, Endpoint: endpoint, Action: jobs.MessagingRun, SourceID: generatedPlanID, OperationID: jobID, PlanVersion: 1})
	if e != nil {
		t.Fatal(e)
	}
	generatedNoticeID := str(object(executed["run"])["id"])
	source.Pool = pool
	generatedRead, e := queries.Query(ctx, actor, "messaging", "read-operation-object", Object{"kind": "notice", "id": generatedNoticeID})
	if e != nil {
		t.Fatal(e)
	}
	generatedData := object(generatedRead["data"])
	if object(generatedData["origin"])["kind"] != "message-plan-run" || object(generatedData["origin"])["runId"] != generatedNoticeID || object(object(generatedData["content"])["audience"])["kind"] != "attributes" {
		t.Fatalf("generated notice origin not retained: %v", generatedData["origin"])
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
		if input["view"] == "plans" || input["kind"] == "message-plan" {
			data := object(result["data"])
			if data["objectType"] != "message-plan" || data["objectMechanism"] != "messaging-state-activate-pause-resume-stop-withdraw" {
				t.Fatalf("plan object metadata: %v", data)
			}
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
	account := str(publicFixture["accounts"].([]any)[0])
	post := object(publicFixture["payload"])
	if _, e = forum.Publish(ctx, account, encoded(post)); e != nil {
		t.Fatal("public activity fixture publication", e)
	}
	reply := community.Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": account, "replyId": uuid.NewString(), "postId": post["postId"], "postVersionId": post["versionId"], "expectedRevision": 0, "body": "Synthetic public reply.", "publishedUntil": now().Add(time.Hour).Unix(), "replyTo": nil}
	community.BindForumIDs("create-reply", account, reply)
	if _, e = forum.CreateReply(ctx, account, encoded(reply)); e != nil {
		t.Fatal("public activity fixture reply", e)
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
			replies, _ := number(object(object(result["businessActivity"])["totals"])["replies"])
			if posts != 1 || replies != 1 {
				t.Fatalf("qualified current publication and reply were not counted %s", encoded(result))
			}
		}
	}
	// Hiding the parent must exclude both it and its still-published reply.
	if _, e = owner.Exec(ctx, `INSERT INTO operations_content_visibility_v1(endpoint,target_kind,target_id,revision,hidden_until,operation_id,updated_at) VALUES($1,'forum-post',$2,1,$3,$4,$5)`, endpoint, post["postId"], now().Add(time.Hour), uuid.NewString(), now()); e != nil {
		t.Fatal(e)
	}
	hidden, e := workbench.SummaryWithAuthority(ctx, queryActor, Object{}, permissions.QueryReader())
	if e != nil {
		t.Fatal("hidden parent public activity", e)
	}
	hiddenTotals := object(object(hidden["businessActivity"])["totals"])
	hiddenPosts, _ := number(hiddenTotals["posts"])
	hiddenReplies, _ := number(hiddenTotals["replies"])
	if hiddenPosts != 0 || hiddenReplies != 0 {
		t.Fatalf("hidden parent or reply was counted: %s", encoded(hiddenTotals))
	}
	if _, e = owner.Exec(ctx, `DELETE FROM operations_content_visibility_v1 WHERE endpoint=$1 AND target_kind='forum-post' AND target_id=$2`, endpoint, post["postId"]); e != nil {
		t.Fatal(e)
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
