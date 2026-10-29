package feedback_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	community "github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestOriginalAIOwnerReceipts(t *testing.T) {
	ctx := context.Background()
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	d := &businessadmin.Domain{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: f.Now}
	feedbackOwner := &feedback.Operations{Service: &feedback.Service{Pool: f.Pool, Endpoint: f.Endpoint}, Domain: d}
	contentOwner := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: f.Now}
	for _, kind := range []string{"feedback", "content"} {
		t.Run(kind, func(t *testing.T) {
			task, ai, call, op, plan, target, grant, strategy, version := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			req := map[string]any{"kind": "feedback-update", "targetId": target, "state": "processing", "note": "test private note"}
			cmd := map[string]any{"expectedRevision": 1, "state": "processing", "note": "test private note"}
			action, permission := "feedback-update", "feedback.update"
			selection := map[string]any{"operationId": op, "expectedRevision": 1, "state": "processing", "id": target, "resourceId": target, "noteHash": identity.Digest([]byte("test private note"))}
			result := map[string]any{"operationId": op, "feedbackId": target, "revision": 2, "recordedAt": "2026-01-01T00:00:00Z"}
			if kind == "content" {
				req = map[string]any{"kind": "content-visibility", "targetId": target, "targetKind": "post", "action": "restore", "reason": "test private reason"}
				cmd = map[string]any{"kind": "restore", "expectedVersion": 1, "expectedRevision": 0, "reason": "test private reason"}
				action, permission = "community-content-visibility", "content.restore"
				selection = map[string]any{"operationId": op, "kind": "restore", "expectedVersion": 1, "expectedRevision": 0, "targetKind": "post", "id": target, "resourceId": target, "reasonDigest": identity.Digest([]byte("test private reason"))}
				result = map[string]any{"operationId": op, "kind": "post", "id": target, "recordedAt": "2026-01-01T00:00:00Z", "visibility": map[string]any{"version": 1, "hidden": false, "until": nil, "operationId": op}}
			}
			operation := map[string]any{"permission": permission, "targetId": target, "operationId": op, "request": req, "command": cmd, "grantId": grant, "grantVersion": 1, "strategyId": strategy, "strategyVersionId": version}
			audit := map[string]any{"kind": "ai", "callId": call, "operationId": op}
			actor := map[string]any{"schemaVersion": 1, "aiAccountId": ai, "domain": "overview", "taskId": task, "planId": plan, "planVersion": 1, "toolCallId": call, "toolOperationId": op, "judgmentKind": "ai", "grantId": grant, "grantVersion": 1, "strategyId": strategy, "strategyVersionId": version}
			binding := map[string]any{"contextSchemaVersion": 1, "accessPurpose": "execution", "endpoint": f.Endpoint, "taskId": task, "aiAccountId": ai, "domain": "overview", "planId": plan, "planVersion": 1, "auditSource": audit, "operation": operation}
			src := businessadmin.OriginalAIReceiptSource{TaskID: task, AIAccountID: ai, Domain: "overview", CallID: call, OperationID: op, PlanID: plan, PlanVersion: 1, Request: req, Command: cmd, Binding: binding}
			tx, e := owner.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(ctx)
			encode := func(v any) []byte {
				b, e := json.Marshal(v)
				if e != nil {
					t.Fatal(e)
				}
				return b
			}
			_, e = tx.Exec(ctx, `INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at) VALUES($1,$2,'fixture','ai','automatic',true,1,$3,'{}',$4,$4,$5,$5)`, grant, f.Endpoint, []string{permission}, f.Root.ID, time.Now())
			if e != nil {
				t.Fatal(e)
			}
			_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,action,operation_id,selection,result,created_at,actor_kind,grant_id,actor_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'operations-ai-service',$9,$10)`, uuid.NewString(), f.Endpoint, "ai:"+ai, action, op, encode(selection), encode(result), time.Now(), grant, encode(actor))
			if e != nil {
				t.Fatal(e)
			}
			read := func(s businessadmin.OriginalAIReceiptSource) (map[string]any, error) {
				if kind == "feedback" {
					return feedbackOwner.OriginalAIReceiptWithin(ctx, tx, f.Root, s)
				}
				return contentOwner.OriginalAIReceiptWithin(ctx, tx, f.Root, s)
			}
			_, sourceState, sourceErr := d.OriginalAIRecordWithin(ctx, tx, src)
			if sourceErr != nil || sourceState != "recorded" {
				t.Fatalf("original source state=%s err=%v", sourceState, sourceErr)
			}
			got, e := read(src)
			if e != nil || got["state"] != "recorded" || got["action"] != permission || got["targetId"] != target {
				t.Fatalf("original receipt %#v %v", got, e)
			}
			delete(actor, "grantVersion")
			delete(operation, "grantVersion")
			if _, e = tx.Exec(ctx, `UPDATE business_admin_audit_v1 SET actor_context=$1 WHERE operation_id=$2`, encode(actor), op); e != nil {
				t.Fatal(e)
			}
			got, e = read(src)
			if e != nil || got["state"] != "unknown" {
				t.Fatalf("missing grant evidence %#v %v", got, e)
			}
			actor["grantVersion"], operation["grantVersion"] = 1, 1
			if _, e = tx.Exec(ctx, `UPDATE business_admin_audit_v1 SET actor_context=$1 WHERE operation_id=$2`, encode(actor), op); e != nil {
				t.Fatal(e)
			}
			bad := src
			bad.TaskID = uuid.NewString()
			if _, e = read(bad); e == nil {
				t.Fatal("different task accepted")
			}
			bad = src
			bad.AIAccountID = uuid.NewString()
			if _, e = read(bad); e == nil {
				t.Fatal("different AI accepted")
			}
			bad = src
			bad.CallID = uuid.NewString()
			if _, e = read(bad); e == nil {
				t.Fatal("different call accepted")
			}
			oldCommand := operation["command"]
			changedCommand := map[string]any{}
			for k, v := range cmd {
				changedCommand[k] = v
			}
			if kind == "feedback" {
				changedCommand["note"] = "different"
			} else {
				changedCommand["reason"] = "different"
			}
			operation["command"] = changedCommand
			bad = src
			bad.Command = changedCommand
			if _, e = read(bad); e == nil {
				t.Fatal("command contradicting request accepted")
			}
			operation["command"] = oldCommand
			hashKey := "noteHash"
			if kind == "content" {
				hashKey = "reasonDigest"
			}
			selection[hashKey] = identity.Digest([]byte("different"))
			if _, e = tx.Exec(ctx, `UPDATE business_admin_audit_v1 SET selection=$1 WHERE operation_id=$2`, encode(selection), op); e != nil {
				t.Fatal(e)
			}
			if _, e = read(src); e == nil {
				t.Fatal("different selection hash accepted")
			}
			bad = src
			bad.Command = nil
			got, e = read(bad)
			if e != nil || got["state"] != "unknown" {
				t.Fatalf("missing original proof %#v %v", got, e)
			}
			bad = src
			bad.OperationID = uuid.NewString()
			got, e = read(bad)
			if e != nil || got["state"] != "not-recorded" {
				t.Fatalf("missing original audit %#v %v", got, e)
			}
		})
	}
}
