package messaging

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs("../../..")
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {migrate} from './packages/galaxy-official/src/infrastructure/database.mjs';import {randomUUID} from 'node:crypto';const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated DB required');const db=new pg.Pool({connectionString:url.href});try{await migrate(db);const endpoint='https://messaging.example.invalid',operatorId='fixture-operator';await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.example.invalid','synthetic','Synthetic',now(),now())",[operatorId,endpoint]);const accounts=[];for(const [index,type]of ['person','agent','organization'].entries()){const id=randomUUID();await db.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://accounts.example.invalid',$3,'external-account',now(),now())",[id,endpoint,'synthetic-'+index]);await db.query("INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,$2,'Synthetic',now())",[id,type]);accounts.push(id)}console.log(JSON.stringify({endpoint,operatorId,accounts}))}finally{await db.end()}`
	cmd := exec.Command("node", "--no-warnings", "--input-type=module", "-e", script)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatal("original schema", e, string(out))
	}
	var data struct {
		Endpoint, OperatorID string
		Accounts             []string
	}
	if e = json.Unmarshal(out, &data); e != nil {
		t.Fatal(e)
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

	// Read the actual Go rows with the original JS services. Only the technical
	// queue engine label changes from pg-boss to River; UI fields stay identical.
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
	script = `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {OperationsPermissionsService} from './packages/galaxy-official/src/operations/permissions/index.mjs';import {BusinessAdminService} from './packages/galaxy-official/src/operations/audit/service.mjs';import {OperationsMessagingService} from './packages/galaxy-official/src/operations/messaging/service.mjs';const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated DB required');const db=new pg.Pool({connectionString:url.href});try{const endpoint='https://messaging.example.invalid',now=()=>2000000000,operatorAuthorization=async()=>'administrator',permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization,now}),businessAdmin=new BusinessAdminService({db,endpoint,permissions,operatorAuthorization,now}),service=new OperationsMessagingService({db,endpoint,businessAdmin,now}),actor={kind:'business-operator',operatorId:'fixture-operator',role:'administrator',endpoint};console.log(JSON.stringify({get:await service.get(actor,process.argv[1]),list:await service.list(actor),run:await service.run(actor,process.argv[2]),recipients:await service.recipients(actor,process.argv[2]),receipt:await service.commandResult(actor,process.argv[3])}))}finally{await db.end()}`
	cmd = exec.Command("node", "--no-warnings", "--input-type=module", "-e", script, str(plan["id"]), str(run["id"]), str(input["operationId"]))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e = cmd.CombinedOutput()
	if e != nil {
		t.Fatal("original readback", e, string(out))
	}
	var original map[string]Object
	if e = json.Unmarshal(out, &original); e != nil {
		t.Fatal(e)
	}
	for _, value := range []Object{obj(getters["get"]["plan"])} {
		obj(value["scheduling"])["engine"] = "pg-boss"
	}
	for _, value := range arr(getters["list"]["items"]) {
		obj(obj(value)["scheduling"])["engine"] = "pg-boss"
	}
	for name, value := range getters {
		if !same(value, original[name]) {
			t.Fatalf("original %s readback differs\nGo %s\nJS %s", name, encode(value), encode(original[name]))
		}
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
	script = `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {OperationsPermissionsService} from './packages/galaxy-official/src/operations/permissions/index.mjs';import {BusinessAdminService} from './packages/galaxy-official/src/operations/audit/service.mjs';import {OperationsNotices} from './packages/galaxy-official/src/operations/messaging/notices.mjs';import {productCommandResult} from './packages/galaxy-official/src/operations/product-command-receipts.mjs';const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(u.hostname!=='127.0.0.1'||!u.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated DB required');const db=new pg.Pool({connectionString:u.href});try{const endpoint='https://messaging.example.invalid',now=()=>2000000000,permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async()=>'administrator',now}),businessAdmin=new BusinessAdminService({db,endpoint,permissions,now}),actor={kind:'business-operator',operatorId:'fixture-operator',role:'administrator',endpoint},notices=new OperationsNotices({db,endpoint,businessAdmin,jobs:{onCancel(){}},now});console.log(JSON.stringify({notice:await notices.get(actor,process.argv[1]),receipt:await productCommandResult({db,endpoint,operator:actor,authorize:a=>businessAdmin.authorizeAction(a,'notices.read'),now},process.argv[2],'notices')}))}finally{await db.end()}`
	cmd = exec.Command("node", "--no-warnings", "--input-type=module", "-e", script, noticeID, publishOperation)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e = cmd.CombinedOutput()
	if e != nil {
		t.Fatal("legacy JS readback", e, string(out))
	}
	var oldReadback struct{ Notice, Receipt Object }
	if e = json.Unmarshal(out, &oldReadback); e != nil {
		t.Fatal(e)
	}
	if !same(legacyGo, oldReadback.Notice) || !same(legacyReceipt, oldReadback.Receipt) {
		t.Fatal("legacy original view/receipt mismatch", encode(legacyGo), encode(oldReadback.Notice), encode(legacyReceipt), encode(oldReadback.Receipt))
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
