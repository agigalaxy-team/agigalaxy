package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type filteredReceiptHuman struct {
	p.StoredPersonAuthority
	principal interface {
		ReadStoredPersonPrincipalWithin(context.Context, pgx.Tx, string) (map[string]string, error)
	}
	denied string
}

type filteredPortalReceiptHuman struct {
	p.Authority
	reader interface {
		ReadHumanSnapshotWithin(context.Context, pgx.Tx, p.Actor) (p.Actor, error)
		ReadOperationsPrincipalWithin(context.Context, pgx.Tx, p.Actor) (map[string]string, error)
	}
}

func (a *filteredPortalReceiptHuman) ReadHumanSnapshotWithin(ctx context.Context, tx pgx.Tx, actor p.Actor) (p.Actor, error) {
	result, err := a.reader.ReadHumanSnapshotWithin(ctx, tx, actor)
	if err == nil {
		permissions := []string{}
		for _, code := range result.Permissions {
			if code != "feedback.read" {
				permissions = append(permissions, code)
			}
		}
		result.Permissions = permissions
	}
	return result, err
}
func (a *filteredPortalReceiptHuman) EffectiveWithin(ctx context.Context, tx pgx.Tx, actor p.Actor) (p.Actor, error) {
	result, err := a.Authority.EffectiveWithin(ctx, tx, actor)
	if err == nil {
		permissions := []string{}
		for _, code := range result.Permissions {
			if code != "feedback.read" {
				permissions = append(permissions, code)
			}
		}
		result.Permissions = permissions
	}
	return result, err
}
func (a *filteredPortalReceiptHuman) ReadOperationsPrincipalWithin(ctx context.Context, tx pgx.Tx, actor p.Actor) (map[string]string, error) {
	return a.reader.ReadOperationsPrincipalWithin(ctx, tx, actor)
}

func (a *filteredPortalReceiptHuman) RequireWithin(ctx context.Context, tx pgx.Tx, actor p.Actor, action string) (p.Actor, error) {
	if action == "feedback.read" {
		return p.Actor{}, fault.New("operations_permission_denied", 403)
	}
	return a.Authority.RequireWithin(ctx, tx, actor, action)
}

func (a *filteredReceiptHuman) PersonWithin(ctx context.Context, tx pgx.Tx, id string, eligibility bool) (p.Actor, error) {
	v, err := a.StoredPersonAuthority.PersonWithin(ctx, tx, id, eligibility)
	if err == nil && a.denied != "" {
		filtered := []string{}
		for _, permission := range v.Permissions {
			if permission != a.denied {
				filtered = append(filtered, permission)
			}
		}
		v.Permissions = filtered
	}
	return v, err
}
func (a *filteredReceiptHuman) ReadStoredPersonPrincipalWithin(ctx context.Context, tx pgx.Tx, id string) (map[string]string, error) {
	return a.principal.ReadStoredPersonPrincipalWithin(ctx, tx, id)
}

type receiptPublicationAuthority struct{}

func (receiptPublicationAuthority) Account(context.Context, pgx.Tx, string, string) error { return nil }

func TestOriginalAIReceiptProductionSourceWiring(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	ctx := context.Background()
	account, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (accounts.Account, error) {
		return (&accounts.Service{Endpoint: f.Endpoint, Now: f.Now}).EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: "https://source.example.invalid", ExternalSubject: "feedback-source", VerificationMethod: "external-account", VerifiedAt: f.Now()})
	})
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	_, err = owner.Exec(ctx, `INSERT INTO operations_feedback_v1(id,endpoint,account_id,submission_operation_id,request_hash,title,body,submitted_module,module,state,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Synthetic feedback','Synthetic detail','other','other','pending',1,$6,$6)`, id, f.Endpoint, account.ID, uuid.NewString(), strings.Repeat("a", 64), f.Now())
	if err != nil {
		t.Fatal(err)
	}
	autonomy := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint}
	publication := publicationfixture.Prepare(t, f.Pool, f.Endpoint, f.Now)
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: receiptPublicationAuthority{}, Now: f.Now, OperationsHandling: true}
	payload := publication["payload"].(community.Object)
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = forum.Publish(ctx, publication["accounts"].([]any)[0].(string), string(raw)); err != nil {
		t.Fatal(err)
	}
	content := &operationscommunity.Service{Pool: f.Pool, Endpoint: f.Endpoint, Forum: forum, Now: f.Now}
	service := connectWorkbenchActions(&agentos.Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Tools: &agentos.ConversationTools{}}, autonomy, content, nil)
	service.Feedback = &feedback.Operations{Service: &feedback.Service{Pool: f.Pool, Endpoint: f.Endpoint}}
	service.AccountGovernance = &operationsaccounts.Service{Domain: &businessadmin.Domain{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}}
	accountSource := func(id string) (agentos.Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (agentos.Object, error) {
			return autonomy.ReadTargetWithin(ctx, tx, f.Root, "overview", "account", id)
		})
	}
	accountValue, accountErr := accountSource(account.ID)
	if accountErr != nil || accountValue["availability"] != "available" || len(accountValue) != 1 {
		t.Fatalf("account metadata source: %v %v", accountValue, accountErr)
	}
	if _, accountErr = accountSource(uuid.NewString()); accountErr == nil {
		t.Fatal("unknown account source accepted")
	}

	check := func(id string) (agentos.Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (agentos.Object, error) {
			return autonomy.ReadTargetWithin(ctx, tx, f.Root, "overview", "feedback", id)
		})
	}
	result, err := check(id)
	if err != nil || result["availability"] != "available" || len(result) != 1 {
		t.Fatalf("live source: %v %v", result, err)
	}
	deleteID := uuid.NewString()
	_, err = owner.Exec(ctx, `INSERT INTO account_feedback_data_operations_v1(operation_id,endpoint,account_id,kind,cutoff_sequence,state,feedback_count,attachment_count,metadata_deleted,created_at,updated_at) VALUES($1,$2,$3,'delete',0,'completed',1,0,true,$4,$4)`, deleteID, f.Endpoint, account.ID, f.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `UPDATE operations_feedback_v1 SET owner_deleted_at=$2,owner_delete_operation_id=$3,title=NULL,body=NULL WHERE id=$1`, id, f.Now(), deleteID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = check(id); fault.Status(err) != 404 {
		t.Fatalf("deleted source accepted: %v", err)
	}
	if _, err = check(uuid.NewString()); fault.Status(err) != 404 {
		t.Fatalf("missing source accepted: %v", err)
	}
	postID := payload["postId"].(string)
	postCheck := func() (agentos.Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (agentos.Object, error) {
			return autonomy.ReadTargetWithin(ctx, tx, f.Root, "overview", "post", postID)
		})
	}
	result, err = postCheck()
	if err != nil || result["availability"] != "available" || len(result) != 1 {
		t.Fatalf("live post source: %v %v", result, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE forum_posts_v1 SET state='withdrawn' WHERE id=$1`, postID); err != nil {
		t.Fatal(err)
	}
	if _, err = postCheck(); fault.Status(err) != 503 {
		t.Fatalf("withdrawn source accepted: %v", err)
	}
}

func TestCaseTaskSourceProductionHumanAndQueryWiring(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	ctx := context.Background()
	automation := f.Automation(t)
	published := publicationfixture.Prepare(t, f.Pool, f.Endpoint, f.Now)
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: receiptPublicationAuthority{}, Now: f.Now, OperationsHandling: true}
	payload := published["payload"].(community.Object)
	raw, _ := json.Marshal(payload)
	account := published["accounts"].([]any)[0].(string)
	if _, e := forum.Publish(ctx, account, string(raw)); e != nil {
		t.Fatal(e)
	}
	report := community.Object{"schemaVersion": 1, "operationId": uuid.NewString(), "reportId": uuid.NewString(), "target": community.Object{"kind": "post-version", "postId": payload["postId"], "versionId": payload["versionId"]}, "category": "privacy", "summary": "Synthetic case"}
	community.BindForumIDs("create-report", account, report)
	raw, _ = json.Marshal(report)
	if _, e := forum.Report(ctx, account, string(raw)); e != nil {
		t.Fatal(e)
	}
	role, e := f.Permissions.SaveRole(ctx, f.Root, agentos.Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Case source isolated role", "description": "Current source read", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"autonomy.read", "cases.read"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", agentos.Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	autonomy := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint}
	content := &operationscommunity.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, ReadPrincipalWithin: f.Gateway.ReadOperationsPrincipalWithin, Forum: forum, Links: &accountlinks.Service{Endpoint: f.Endpoint}, Now: f.Now}
	connectWorkbenchActions(&agentos.Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Tools: &agentos.ConversationTools{}}, autonomy, content, nil)
	id := report["reportId"].(string)
	read := func(query bool) (agentos.Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (agentos.Object, error) {
			a := f.Root
			if query {
				var err error
				a, err = f.Permissions.HumanAIAccountReadWithin(ctx, tx, a, "overview", automation["accounts"].(map[string]any)["overview"].(string), "query", "cases.read")
				if err != nil {
					return nil, err
				}
			}
			return autonomy.ReadTargetWithin(ctx, tx, a, "overview", "case", id)
		})
	}
	for _, query := range []bool{false, true} {
		v, err := read(query)
		if err != nil || v["availability"] != "available" || len(v) != 1 {
			t.Fatalf("case source query=%v: %v %v", query, v, err)
		}
	}
	if _, err := owner.Exec(ctx, `UPDATE forum_reports_v1 SET state='resolved' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if v, err := read(true); err != nil || v["availability"] != "available" {
		t.Fatalf("resolved case source %v %v", v, err)
	}
	if _, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (agentos.Object, error) {
		a := f.Root
		a.AIProof = struct{}{}
		return autonomy.ReadTargetWithin(ctx, tx, a, "overview", "case", id)
	}); fault.Status(err) != 403 {
		t.Fatalf("fake query proof: %v", err)
	}
}

func TestOriginalAIReceiptNormalizesAndBindsWholeCall(t *testing.T) {
	target := uuid.NewString()
	call := map[string]any{"kind": "feedback-update", "targetId": target, "state": "processing"}
	src := businessadmin.OriginalAIReceiptSource{CallArguments: call, Request: call, Command: map[string]any{"expectedRevision": 1}}
	if _, e := normalizeOriginalAIReceiptSource(src); e != nil {
		t.Fatal(e)
	}
	src.Request = map[string]any{"kind": "feedback-update", "targetId": target, "state": "closed"}
	if _, e := normalizeOriginalAIReceiptSource(src); fault.Status(e) != 404 {
		t.Fatalf("changed command accepted: %v", e)
	}
	src.Request = call
	src.CallArguments = map[string]any{"kind": "feedback-update", "targetId": target, "state": "processing", "unrecognized": "private"}
	if _, e := normalizeOriginalAIReceiptSource(src); fault.Status(e) != 404 {
		t.Fatalf("extra input accepted: %v", e)
	}
}

func TestFileOriginalAIReceiptBindsWholeCall(t *testing.T) {
	target := uuid.NewString()
	call := map[string]any{"kind": "file-access", "targetKind": "forum", "targetId": target, "action": "stop", "until": int64(2000001800), "reason": "Synthetic reason"}
	src := businessadmin.OriginalAIReceiptSource{CallArguments: call, Request: call, Command: map[string]any{"expectedRevision": 1}}
	if _, err := normalizeOriginalAIReceiptSource(src); err != nil {
		t.Fatal(err)
	}
	src.Request = map[string]any{"kind": "file-access", "targetKind": "forum", "targetId": target, "action": "stop", "until": int64(2000001800), "reason": "Changed reason"}
	if _, err := normalizeOriginalAIReceiptSource(src); fault.Status(err) != 404 {
		t.Fatalf("changed reason accepted: %v", err)
	}
}

func TestConversationOriginalAIReceiptCrossRoleAndHumanRevocation(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	ctx := context.Background()
	automation := f.Automation(t)
	accountsByDomain := automation["accounts"].(map[string]any)
	role := automation["role"].(map[string]any)["id"]
	if _, err := owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=array_append(permissions,'autonomy.read') WHERE id=$1`, role); err != nil {
		t.Fatal(err)
	}
	account, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (accounts.Account, error) {
		return (&accounts.Service{Endpoint: f.Endpoint, Now: f.Now}).EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: "https://source.example.invalid", ExternalSubject: "cross-role", VerificationMethod: "external-account", VerifiedAt: f.Now()})
	})
	if err != nil {
		t.Fatal(err)
	}
	target, task, operation, call := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO operations_feedback_v1(id,endpoint,account_id,submission_operation_id,request_hash,title,body,submitted_module,module,state,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Synthetic feedback','Synthetic detail','other','other','pending',1,$6,$6)`, target, f.Endpoint, account.ID, uuid.NewString(), strings.Repeat("a", 64), f.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_tasks_v1(id,endpoint,domain,source,source_key,title,mode,state,model_state,business_state,ai_account_id,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,'overview','routine',$1::uuid::text,'fixture','ai','unknown','failed','unknown',$3,'{}',1,1,$4,now(),now(),now())`, task, f.Endpoint, accountsByDomain["overview"], uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"kind": "feedback-update", "targetId": target, "state": "processing"}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'execute-operation',$4,$5,'unknown',now(),now())`, f.Endpoint, task, call, args, operation); err != nil {
		t.Fatal(err)
	}
	conversations := &agentos.Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now, Tools: &agentos.ConversationTools{}}
	current, err := conversations.Session(ctx, f.Root, "governance", true)
	if err != nil {
		t.Fatal(err)
	}
	autonomy := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	service := connectWorkbenchActions(conversations, autonomy, nil, nil)
	service.Feedback = &feedback.Operations{Service: &feedback.Service{Pool: f.Pool, Endpoint: f.Endpoint}, Domain: &businessadmin.Domain{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: f.Now}}
	request := map[string]any{"taskId": task, "operationId": operation}
	result, err := conversations.Tools.ReadTaskOperation(ctx, current.Actor, *current.Row, request)
	if err != nil || result["availability"] != "available" || result["receipt"].(map[string]any)["state"] != "not-recorded" {
		t.Fatalf("cross-role original read %#v %v", result, err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,action,operation_id,selection,result,created_at,actor_kind,actor_context) VALUES($1,$2,$3,'feedback-update',$4,'{}','{}',$5,'operations-ai-service',NULL)`, uuid.NewString(), f.Endpoint, "ai:"+accountsByDomain["overview"].(string), operation, f.Now()); err != nil {
		t.Fatal(err)
	}
	result, err = conversations.Tools.ReadTaskOperation(ctx, current.Actor, *current.Row, request)
	if err != nil || result["receipt"].(map[string]any)["state"] != "unknown" {
		t.Fatalf("missing original binding must stay unknown %#v %v", result, err)
	}
	if _, err = conversations.Tools.ReadTaskOperation(ctx, current.Actor, *current.Row, map[string]any{"taskId": uuid.NewString(), "operationId": operation}); fault.Status(err) != 404 {
		t.Fatalf("wrong task accepted: %v", err)
	}
	stored := f.Gateway.StoredOperators()
	f.Permissions.StoredAuthority = &filteredReceiptHuman{StoredPersonAuthority: stored, principal: stored, denied: "feedback.read"}
	f.Permissions.Authority = &filteredPortalReceiptHuman{Authority: f.Gateway, reader: f.Gateway}
	if _, err = conversations.Tools.ReadTaskOperation(ctx, current.Actor, *current.Row, request); fault.Status(err) != 403 {
		t.Fatalf("human revoked feedback read: %v", err)
	}
}
