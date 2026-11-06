package operationsautonomy_test

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/communitygrowth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type assessmentActivationNative struct {
	runs int
	row  a.Object
}

func (n *assessmentActivationNative) Run(_ context.Context, row a.Object) (a.Object, error) {
	n.runs++
	n.row = row
	return a.Object{"taskId": row["id"], "sessionId": row["session_id"], "nativeRunId": "owned-assessment-run", "nativeAttemptId": row["native_attempt_id"], "status": "RUNNING", "modelState": "running", "continuable": false}, nil
}
func (n *assessmentActivationNative) Read(context.Context, a.Object) (a.Object, error) {
	return nil, nil
}
func (n *assessmentActivationNative) Cancel(context.Context, a.Object) (a.Object, error) {
	return nil, nil
}
func (n *assessmentActivationNative) Continue(context.Context, a.Object) (a.Object, error) {
	return nil, nil
}

func TestCommunityCalculationUsesItsOwnActivation(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.NewEndpoint(t, owner, "https://assessment-owner.example.invalid")
	f.Automation(t)
	role, err := f.Permissions.SaveRole(ctx, f.Root, a.Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Community calculation", "description": "Public material calculation", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"analytics.read"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "discovery", a.Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	native := &assessmentActivationNative{}
	svc := &a.Service{Pool: f.Pool, Endpoint: f.Endpoint, AIWork: f.Permissions.AIWork, Authority: f.Gateway, Now: f.Now, Native: native,
		EnqueueWithin: func(context.Context, pgx.Tx, string, a.Object, string, *time.Time) error { return nil }}
	svc.Permissions, f.Permissions.Duty = f.Permissions, svc
	if _, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (bool, error) { err := svc.EnsureWithin(ctx, tx); return err == nil, err }); err != nil {
		t.Fatal(err)
	}
	var executor string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND domain='discovery'`, f.Endpoint).Scan(&executor); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=false,configuration=jsonb_set(configuration,'{mode}','"code"') WHERE id=$1`, executor); err != nil {
		t.Fatal(err)
	}
	publication := publicationfixture.Prepare(t, owner, f.Endpoint, f.Now)
	account := publication["accounts"].([]any)[0].(string)
	growth := &communitygrowth.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: &operationspermissions.BusinessAuthority{Human: f.Gateway}, Now: f.Now}
	assessment := &communitygrowth.AssessmentService{Service: growth, ReadSourceWithin: func(context.Context, pgx.Tx, communitygrowth.AssessmentSource) (communitygrowth.Object, error) {
		return nil, nil
	}}
	svc.ConnectCommunityAssessments(assessment)
	if _, err := assessment.SaveConfiguration(ctx, f.Root, communitygrowth.Object{"kind": "assessment-config-save", "operationId": uuid.NewString(), "expectedVersion": 1, "enabled": true, "executorConfigId": executor, "purposes": []string{"contribution-impact"}, "instructions": "按已确认用途理解公开材料；不足以判断时保留未知。"}); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `INSERT INTO community_assessment_scopes_v1(endpoint,account_id,domain,purpose,next_attempt_at,updated_at) VALUES($1,$2,'technology','contribution-impact',$3,$3)`, f.Endpoint, account, f.Now()); err != nil {
		t.Fatal(err)
	}
	queued, err := (&communitygrowth.AssessmentWorker{Service: assessment}).Step(ctx)
	if err != nil || queued["state"] != "queued" {
		t.Fatalf("independent calculation could not queue: %v %v", queued, err)
	}
	id := queued["taskId"].(string)
	// A routine configuration save must affect only the routine's own tasks.
	if _, err = svc.SaveConfig(ctx, f.Root, "discovery", a.Object{"operationId": uuid.NewString(), "expectedRevision": 1, "enabled": false, "mode": "code", "schedule": a.Object{"kind": "interval", "minutes": 60}, "purpose": "operations-discovery", "goal": "", "prompt": "", "plan": a.Object{}}, func(context.Context) (a.Actor, error) { return f.Root, nil }); err != nil {
		t.Fatal(err)
	}
	result, err := a.NewWorker(svc).Execute(ctx, a.Object{"taskId": id})
	if err != nil || result["state"] != "running" || native.runs != 1 {
		t.Fatalf("routine switch/mode controlled a separately enabled calculation: %v runs=%d %v", result, native.runs, err)
	}
	var enabled bool
	var mode string
	if err = owner.QueryRow(ctx, `SELECT enabled,configuration->>'mode' FROM operations_autonomy_configs_v1 WHERE id=$1`, executor).Scan(&enabled, &mode); err != nil || enabled || mode != "code" {
		t.Fatal("routine configuration changed", enabled, mode, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE community_assessment_config_v1 SET enabled=false WHERE endpoint=$1`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Authorize(ctx, a.Object{"taskId": id, "operation": "run", "nativeAttemptId": native.row["native_attempt_id"]})
	if err == nil || fault.Code(err) != "operations_autonomy_task_inactive" {
		t.Fatalf("disabled calculation retained execution authority: %v", err)
	}
}
