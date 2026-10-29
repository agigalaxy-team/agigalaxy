package operationscommunity_test

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	ops "github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCaseSourceMetadataKeepsOriginalReadSemanticsPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.Principals(t, owner, "https://permissions.example.invalid", map[string]string{"root": "R", "writer": "W", "empty": "E"})
	fixture := seedManagedForum(t, owner, f)
	id := str(obj(fixture["report"])["reportId"])
	s := &ops.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, ReadPrincipalWithin: f.Gateway.ReadOperationsPrincipalWithin, Forum: &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now}, Links: &accountlinks.Service{Endpoint: f.Endpoint}, Now: f.Now}
	read := func(id string) (map[string]any, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (map[string]any, error) { return s.CaseReadSourceWithin(ctx, tx, f.Root, id) })
	}
	value, err := read(id)
	if err != nil || value["id"] != id || value["available"] != true || len(value) != 3 {
		t.Fatalf("original metadata %#v %v", value, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE forum_reports_v1 SET state='resolved',audit_until=$2 WHERE id=$1`, id, f.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	value, err = read(id)
	if err != nil || value["available"] != true || len(value) != 3 {
		t.Fatalf("resolved/expired metadata %#v %v", value, err)
	}
	if _, err = read(uuid.NewString()); fault.Status(err) != 404 {
		t.Fatalf("missing case %v", err)
	}
}

func TestCaseOriginalReceiptRequiresMatchingAuditAndRetainedEventPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.Principals(t, owner, "https://permissions.example.invalid", map[string]string{"root": "R", "writer": "W", "empty": "E"})
	fixture := seedManagedForum(t, owner, f)
	id := str(obj(fixture["report"])["reportId"])
	ai := f.Automation(t)["accounts"].(map[string]any)["overview"].(string)
	task, call, op, plan, grant, strategy, version := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	request := object{"kind": "case-resolve", "targetId": id, "resolution": "needs-review", "summary": "Controlled case review"}
	command := object{"expectedVersion": 1, "resolution": "needs-review", "summary": "Controlled case review"}
	operation := object{"permission": "cases.resolve", "targetId": id, "operationId": op, "request": request, "command": command, "grantId": grant, "grantVersion": 1, "strategyId": strategy, "strategyVersionId": version}
	binding := object{"taskId": task, "aiAccountId": ai, "domain": "overview", "planId": plan, "planVersion": 1, "contextSchemaVersion": 1, "accessPurpose": "execution", "endpoint": f.Endpoint, "operation": operation, "auditSource": object{"kind": "ai", "callId": call, "operationId": op}}
	src := businessadmin.OriginalAIReceiptSource{TaskID: task, AIAccountID: ai, Domain: "overview", CallID: call, OperationID: op, PlanID: plan, PlanVersion: 1, Request: request, Command: command, Binding: binding, CallArguments: request}
	actorContext := object{"schemaVersion": 1, "taskId": task, "aiAccountId": ai, "domain": "overview", "planId": plan, "planVersion": 1, "toolCallId": call, "toolOperationId": op, "judgmentKind": "ai", "grantId": grant, "grantVersion": 1, "strategyId": strategy, "strategyVersionId": version}
	if _, e := owner.Exec(ctx, `INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,ai_account_id,resource_scope_kind) VALUES($1,$2,'Case fixture','ai','automatic',true,1,ARRAY['cases.resolve'],ARRAY[$3]::uuid[],$4,$4,$5,$5,$6,'selected')`, grant, f.Endpoint, id, f.Root.ID, f.Now(), ai); e != nil {
		t.Fatal(e)
	}
	selection := object{"operationId": op, "id": id, "resourceId": id, "expectedVersion": 1, "resolution": "needs-review", "summaryDigest": identity.Digest([]byte("Controlled case review"))}
	result := object{"operationId": op, "reportId": id, "version": 2, "state": "resolved", "resolution": "needs-review", "restrictionAction": "keep", "restrictionEventId": nil, "effectUntil": nil, "recordedAt": f.Now().UTC().Format(time.RFC3339Nano)}
	if _, e := owner.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,action,operation_id,selection,result,created_at,actor_kind,grant_id,actor_context) VALUES($1,$2,$3,'community-report-resolve',$4,$5,$6,$7,'operations-ai-service',$8,$9)`, uuid.NewString(), f.Endpoint, "ai:"+ai, op, selection, result, f.Now(), grant, actorContext); e != nil {
		t.Fatal(e)
	}
	if _, e := owner.Exec(ctx, `INSERT INTO forum_operations_events_v1(id,report_id,operator_id,version,resolution,summary,created_at,retained_until,restriction_action,actor_kind) VALUES($1,$2,$3,2,'needs-review','Controlled case review',$4,$5,'keep','operations-ai-service')`, op, id, "ai:"+ai, f.Now(), f.Now().Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	s := &ops.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, ReadPrincipalWithin: f.Gateway.ReadOperationsPrincipalWithin, Forum: &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now}, Links: &accountlinks.Service{Endpoint: f.Endpoint}, Now: f.Now}
	read := func() (map[string]any, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (map[string]any, error) { return s.CaseOriginalAIReceiptWithin(ctx, tx, f.Root, src) })
	}
	value, e := read()
	if e != nil || value["state"] != "recorded" || value["targetId"] != id || value["version"] != float64(2) || len(value) != 8 {
		t.Fatalf("recorded %#v %v", value, e)
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_operations_events_v1 SET summary='tampered' WHERE id=$1`, op); e != nil {
		t.Fatal(e)
	}
	if _, e = read(); fault.Status(e) != 404 {
		t.Fatalf("changed original event %v", e)
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_operations_events_v1 SET retained_until=$2 WHERE id=$1`, op, f.Now().Add(-time.Second)); e != nil {
		t.Fatal(e)
	}
	value, e = read()
	if e != nil || value["state"] != "unknown" {
		t.Fatalf("expired material %#v %v", value, e)
	}
}
