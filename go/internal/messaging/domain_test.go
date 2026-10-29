package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Only the external management/recipient directory is a controlled test double.
// Domain commands, transactions, original tables and River enqueue are real.
type domainAuthority struct {
	actor  Actor
	denied atomic.Bool
}

func (a *domainAuthority) AuthorizeOperations(*http.Request, bool, string) (Actor, error) {
	return a.actor, nil
}
func (a *domainAuthority) RequireWithin(ctx context.Context, tx pgx.Tx, actor Actor, permission string) (Actor, error) {
	if actor.ID != a.actor.ID || actor.Endpoint != a.actor.Endpoint || a.denied.Load() {
		return Actor{}, fault.New("operations_permission_denied", 403)
	}
	return a.actor, nil
}
func (a *domainAuthority) EffectiveWithin(context.Context, pgx.Tx, Actor) (Actor, error) {
	return a.actor, nil
}
func (a *domainAuthority) PersonWithin(context.Context, pgx.Tx, string, bool) (Actor, error) {
	if a.denied.Load() {
		return Actor{}, fault.New("operations_permission_denied", 403)
	}
	return a.actor, nil
}
func TestOriginalPostgresPlanRunAudienceInappReplayAndRevocation(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	data := struct {
		Endpoint, OperatorID string
		Accounts             []string
	}{Endpoint: "https://messaging.example.invalid", OperatorID: "fixture-operator"}
	if _, err := pool.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.example.invalid','synthetic','Synthetic',now(),now())`, data.OperatorID, data.Endpoint); err != nil {
		t.Fatal(err)
	}
	for index, kind := range []string{"person", "agent", "organization"} {
		id := uuid.NewString()
		if _, err := pool.Exec(ctx, `INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://accounts.example.invalid',$3,'external-account',now(),now())`, id, data.Endpoint, fmt.Sprintf("synthetic-%d", index)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,$2,'Synthetic',now())`, id, kind); err != nil {
			t.Fatal(err)
		}
		data.Accounts = append(data.Accounts, id)
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, pool, tx); e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	queue, e := jobs.New(pool, nil)
	if e != nil {
		t.Fatal(e)
	}
	at := time.Unix(2000000000, 0)
	authority := &domainAuthority{actor: Actor{ID: data.OperatorID, Role: "administrator", Endpoint: data.Endpoint, Permissions: []string{"notices.read", "notices.create", "notices.update", "notices.publish", "notices.withdraw"}}}
	service := &Service{Pool: pool, Endpoint: data.Endpoint, Authority: authority, Approver: authority, Jobs: queue, Now: func() time.Time { return at }, Directory: func(_ context.Context, issuer, subject string) (DirectoryIdentity, error) {
		return DirectoryIdentity{Issuer: issuer, ExternalSubject: subject, State: "available", Enabled: true, EmailVerified: true, Email: "synthetic@example.invalid"}, nil
	}}
	input := Object{"operationId": uuid.NewString(), "config": Object{"channels": []any{"announcement", "inapp"}, "content": Object{"purpose": "service-update", "title": "Synthetic title", "body": "Synthetic content", "expiresAt": iso(at.Add(time.Hour))}, "audience": Object{"kind": "attributes", "subjectTypes": []any{"person", "agent"}}, "schedule": Object{"kind": "immediate"}}}
	created, e := service.Create(ctx, authority.actor, input)
	if e != nil {
		t.Fatal("create", e)
	}
	plan := obj(created["plan"])
	if str(obj(plan["config"])["senderKey"]) != "notice" {
		t.Fatal("original config defaults")
	}
	again, e := service.Create(ctx, authority.actor, input)
	if e != nil || !boolValue(again["replayed"]) || str(obj(again["plan"])["id"]) != str(plan["id"]) {
		t.Fatal("command replay", e)
	}
	active, e := service.Action(ctx, authority.actor, str(plan["id"]), "activate", Object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 1})
	if e != nil {
		t.Fatal("activate", e)
	}
	plan = obj(active["plan"])
	task := jobs.Task{ID: str(plan["jobId"]), Endpoint: data.Endpoint, Action: jobs.MessagingRun, SourceID: str(plan["id"]), OperationID: str(plan["jobId"]), PlanVersion: 1}
	executed, e := service.ExecutePlan(ctx, task)
	if e != nil {
		t.Fatal("execute", e)
	}
	run := obj(executed["run"])
	// The actual inapp notice is bound to this original plan version; its
	// attribute audience is a plan shape, not a standalone notice command.
	generated, e := service.NoticeGet(ctx, authority.actor, str(run["id"]))
	if e != nil {
		t.Fatal("generated notice read", e)
	}
	generatedNotice := obj(generated["notice"])
	if str(obj(generatedNotice["origin"])["kind"]) != "message-plan-run" || str(obj(generatedNotice["origin"])["runId"]) != str(run["id"]) || str(obj(obj(generatedNotice["readContent"])["audience"])["kind"]) != "attributes" || obj(generatedNotice["readContent"])["messagingRunId"] != nil {
		t.Fatalf("generated notice origin mismatch: %v", generatedNotice["origin"])
	}
	var originalContent Object
	if e = pool.QueryRow(ctx, "SELECT content FROM operations_notices_v1 WHERE id=$1", run["id"]).Scan(&originalContent); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `UPDATE operations_notices_v1 SET content=jsonb_set(content,'{messagingRunId}',to_jsonb($2::text)) WHERE id=$1`, run["id"], uuid.NewString()); e != nil {
		t.Fatal(e)
	}
	if _, e = service.NoticeGet(ctx, authority.actor, str(run["id"])); e == nil {
		t.Fatal("forged notice marker accepted")
	}
	if _, e = pool.Exec(ctx, "UPDATE operations_notices_v1 SET content=$2 WHERE id=$1", run["id"], originalContent); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `UPDATE operations_notices_v1 SET content=jsonb_set(content,'{title}',to_jsonb('changed'::text)) WHERE id=$1`, run["id"]); e != nil {
		t.Fatal(e)
	}
	if _, e = service.NoticeGet(ctx, authority.actor, str(run["id"])); e == nil {
		t.Fatal("notice content inconsistent with source version accepted")
	}
	if _, e = pool.Exec(ctx, "UPDATE operations_notices_v1 SET content=$2 WHERE id=$1", run["id"], originalContent); e != nil {
		t.Fatal(e)
	}
	if num(obj(run["audience"])["accountCount"]) != 2 || str(obj(run["announcement"])["state"]) != "published" {
		t.Fatal("audience/announcement", encode(run))
	}
	replay, e := service.ExecutePlan(ctx, task)
	if e != nil || !boolValue(replay["replayed"]) || str(obj(replay["run"])["id"]) != str(run["id"]) {
		t.Fatal("run replay", e)
	}
	// A changed real account attribute after audience freeze removes eligibility;
	// no later account is added to the frozen recipient set.
	if _, e = pool.Exec(ctx, "UPDATE official_account_profiles_v1 SET subject_type='organization' WHERE account_id=$1", data.Accounts[1]); e != nil {
		t.Fatal(e)
	}
	delivered, e := service.Deliver(ctx, str(run["id"]))
	if e != nil {
		t.Fatal("deliver", e)
	}
	counts := obj(obj(obj(delivered["run"])["delivery"])["inapp"])
	if num(counts["delivered"]) != 1 || num(counts["skipped"]) != 1 {
		t.Fatal("eligibility", encode(delivered))
	}
	page, e := service.Recipients(ctx, authority.actor, str(run["id"]), Object{"limit": 1})
	if e != nil || len(arr(page["items"])) != 1 || page["nextAfter"] == nil {
		t.Fatal("recipient read", e)
	}
	announcements, e := service.Announcements(ctx, Object{})
	if e != nil || len(arr(announcements["items"])) != 1 {
		t.Fatal("public announcement", e)
	}
	if _, e = service.Retry(ctx, authority.actor, str(run["id"]), Object{"operationId": uuid.NewString(), "expectedRevision": obj(delivered["run"])["revision"]}); fault.Code(e) != "operations_messaging_retry_not_allowed" {
		t.Fatal("invented retry", e)
	}

	// Read the actual Go-owned plan, run, recipients and retained command receipt.
	getters := map[string]Object{}
	getters["get"], e = service.Get(ctx, authority.actor, str(plan["id"]))
	if e != nil {
		t.Fatal(e)
	}
	getters["list"], e = service.List(ctx, authority.actor, Object{})
	if e != nil {
		t.Fatal(e)
	}
	getters["run"], e = service.Run(ctx, authority.actor, str(run["id"]))
	if e != nil {
		t.Fatal(e)
	}
	getters["recipients"], e = service.Recipients(ctx, authority.actor, str(run["id"]), Object{})
	if e != nil {
		t.Fatal(e)
	}
	getters["receipt"], e = service.CommandResult(ctx, authority.actor, str(input["operationId"]))
	if e != nil {
		t.Fatal(e)
	}
	if str(obj(getters["get"]["plan"])["id"]) != str(plan["id"]) || len(arr(getters["list"]["items"])) != 1 || str(obj(getters["run"]["run"])["id"]) != str(run["id"]) || len(arr(getters["recipients"]["items"])) != 2 || getters["receipt"] == nil {
		t.Fatal("current plan/run/recipient readback changed", getters)
	}

	// Legacy notices keep their original ledger and online-account inbox.
	noticeInput := Object{"operationId": uuid.NewString(), "content": Object{"purpose": "maintenance", "title": "  Original <&> title  ", "body": "Original body <&>\u2028line", "href": nil, "audience": Object{"kind": "accounts", "accountIds": []any{data.Accounts[0]}}, "expiresAt": iso(at.Add(time.Hour))}}
	oldNotice, e := service.NoticeCreate(ctx, authority.actor, noticeInput)
	if e != nil {
		t.Fatal("legacy create", e)
	}
	noticeID := str(obj(oldNotice["notice"])["id"])
	accountProof := accountFixtureAuthorization{endpoint: data.Endpoint, id: data.Accounts[0]}
	inbox, e := service.NoticeAccountQuery(ctx, data.Accounts[0], accountProof, Object{})
	if e != nil {
		t.Fatal(e)
	}
	beforeItems := len(arr(inbox["items"]))
	publishOperation := uuid.NewString()
	published, e := service.NoticeAction(ctx, authority.actor, noticeID, "publish", Object{"operationId": publishOperation, "expectedVersion": 1})
	if e != nil {
		t.Fatal("legacy publish", e)
	}
	inbox, e = service.NoticeAccountQuery(ctx, data.Accounts[0], accountProof, Object{})
	if e != nil || len(arr(inbox["items"])) != beforeItems {
		t.Fatal("pending notice visible", e)
	}
	notice := obj(published["notice"])
	worked, e := service.Work(ctx, jobs.Task{ID: str(notice["jobId"]), Endpoint: data.Endpoint, Action: jobs.AccountNotice, SourceID: noticeID, OperationID: str(notice["jobId"])})
	if e != nil || str(worked.Result["state"]) != "delivered" {
		t.Fatal("legacy worker", e, worked.Result)
	}
	inbox, e = service.NoticeAccountQuery(ctx, data.Accounts[0], accountProof, Object{})
	if e != nil || len(arr(inbox["items"])) != beforeItems+1 {
		t.Fatal("legacy inbox missing", e)
	}
	if _, e = service.NoticeAccountMarkRead(ctx, data.Accounts[0], accountProof, Object{"noticeId": noticeID}); e != nil {
		t.Fatal(e)
	}
	if _, e = service.NoticeAction(ctx, authority.actor, noticeID, "withdraw", Object{"operationId": uuid.NewString(), "expectedVersion": 2}); e != nil {
		t.Fatal("legacy withdraw", e)
	}
	inbox, e = service.NoticeAccountQuery(ctx, data.Accounts[0], accountProof, Object{})
	if e != nil || len(arr(inbox["items"])) != beforeItems {
		t.Fatal("withdrawn notice still visible", e)
	}
	legacyGo, e := service.NoticeGet(ctx, authority.actor, noticeID)
	if e != nil {
		t.Fatal(e)
	}
	legacyReceipt, e := service.NoticeCommandResult(ctx, authority.actor, publishOperation)
	if e != nil || str(obj(legacyReceipt["result"])["state"]) != "queued" {
		t.Fatal("receipt fell back to current state", e, encode(legacyReceipt))
	}
	if str(obj(legacyGo["notice"])["id"]) != noticeID {
		t.Fatal("notice readback changed", legacyGo)
	}

	// HTTP uses the same real services and verifies strict body/query contracts.
	httpServer := httptest.NewServer(Handler{Service: service, Authority: authority, Accounts: accounts.HTTPIdentityFunc(func(*http.Request, bool) (string, accounts.Authorization, error) {
		return data.Accounts[0], accountProof, nil
	})})
	defer httpServer.Close()
	response, e := httpServer.Client().Get(httpServer.URL + "/v1/operations/messaging/plans?limit=0x1")
	if e != nil {
		t.Fatal(e)
	}
	var reply Object
	json.NewDecoder(response.Body).Decode(&reply)
	response.Body.Close()
	if response.StatusCode != 200 || len(arr(reply["items"])) != 1 {
		t.Fatal("HTTP query contract", response.StatusCode, encode(reply))
	}
	raw := encode(Object{"operationId": uuid.NewString(), "config": input["config"], "actor": Object{"role": "administrator"}})
	response, e = httpServer.Client().Post(httpServer.URL+"/v1/operations/messaging/plans", "application/json", strings.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	json.NewDecoder(response.Body).Decode(&reply)
	response.Body.Close()
	if response.StatusCode != 400 || str(reply["error"]) != "invalid_operations_messaging_request" {
		t.Fatal("caller actor accepted", response.StatusCode, encode(reply))
	}
	response, e = httpServer.Client().Get(httpServer.URL + "/v1/account/notifications/notices?unreadOnly=true")
	if e != nil {
		t.Fatal(e)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("HTTP account inbox", response.StatusCode)
	}
	// Current authority failure is persisted with original recorded attribution.
	pendingNotice, e := service.NoticeCreate(ctx, authority.actor, Object{"operationId": uuid.NewString(), "content": noticeInput["content"]})
	if e != nil {
		t.Fatal(e)
	}
	pendingID := str(obj(pendingNotice["notice"])["id"])
	if _, e = service.NoticeAction(ctx, authority.actor, pendingID, "publish", Object{"operationId": uuid.NewString(), "expectedVersion": 1}); e != nil {
		t.Fatal(e)
	}
	authority.denied.Store(true)
	if _, e = service.DeliverNotice(ctx, pendingID); fault.Code(e) != "operations_permission_denied" {
		t.Fatal("revoked notice delivered", e)
	}
	var completed int
	pool.QueryRow(ctx, "SELECT count(*) FROM account_operations_notices_v1 WHERE notice_id=$1 AND delivered_at IS NOT NULL", pendingID).Scan(&completed)
	if completed != 0 {
		t.Fatal("revoked notice recipients changed")
	}
	authority.denied.Store(true)
	if _, e = service.Get(ctx, authority.actor, str(plan["id"])); fault.Code(e) != "operations_permission_denied" {
		t.Fatal("revoked read allowed", e)
	}
}

type accountFixtureAuthorization struct{ endpoint, id string }

func (a accountFixtureAuthorization) Account(_ context.Context, _ pgx.Tx, endpoint, id string) error {
	if endpoint != a.endpoint || id != a.id {
		return fault.New("access_denied", 403)
	}
	return nil
}
