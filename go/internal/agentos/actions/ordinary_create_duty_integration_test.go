package actions

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOrdinaryCreateThroughOpaqueDutyAndOriginalReceiptPG(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	base := autonomyfixture.Setup(t, f, automation)
	config, _ := pgxpool.ParseConfig(dsn)
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	work := &operationsai.Service{Endpoint: f.Endpoint}
	duty := &operationsautonomy.Service{Pool: pool, Endpoint: f.Endpoint, AIWork: work, Now: now}
	permissions := &operationspermissions.Service{Pool: pool, Endpoint: f.Endpoint, AIWork: work, Duty: duty, Now: now}
	strategy := &operationsstrategies.Service{Pool: pool, Endpoint: f.Endpoint, Authority: &operationspermissions.BusinessAuthority{Duty: duty}, Duty: duty, Now: now}
	service := &Service{Pool: pool, Endpoint: f.Endpoint, Permissions: permissions, Autonomy: duty, Strategies: strategy, Now: now}
	duty.Permissions, duty.ActionReady, duty.QualifyTargetWithin, duty.ExecuteDutyOperation = permissions, service.ActionReady, service.QualifyTargetWithin, service.ExecuteDutyOperation
	taskID, sourceID := uuid.NewString(), uuid.NewString()
	_, err = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return duty.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: taskID, Domain: "overview", AIAccountID: str(base["aiAccountId"])})
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true WHERE endpoint=$1 AND domain='overview'`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET source='routine' WHERE endpoint=$1 AND id=$2`, f.Endpoint, taskID); err != nil {
		t.Fatal(err)
	}
	policy := autonomyfixture.Operation(t, owner, f.Endpoint, f.IDs["root"], taskID, str(base["aiAccountId"]), sourceID, "strategies.ordinary.configure", false)
	if _, err = owner.Exec(ctx, `UPDATE operations_business_roles_v1 SET permissions=ARRAY['strategies.read','strategies.ordinary.configure','strategies.ordinary.publish'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, base["role"]); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET permissions=ARRAY['strategies.ordinary.configure','strategies.ordinary.publish'] WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"]); err != nil {
		t.Fatal(err)
	}
	var sourceConfig Object
	if err = owner.QueryRow(ctx, `SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"]).Scan(&sourceConfig); err != nil {
		t.Fatal(err)
	}
	manager := obj(items(sourceConfig["strategies"])[0])
	obj(manager["execution"])["actions"] = []any{"strategies.ordinary.configure", "strategies.ordinary.publish"}
	source := Object{"id": sourceID, "name": "受控来源", "domain": "overview", "objective": nil, "enabled": false, "mode": "ai-autonomous", "template": "analysis-only", "execution": nil, "judgment": "prepared-command", "instructions": nil, "condition": nil, "ordinaryBounds": Object{"parameters": []any{}, "modes": []any{"ai-autonomous"}, "canEnable": true, "canDisable": true, "canCreate": true}, "recovery": Object{"versionId": nil, "conditions": []any{}}}
	sourceConfig["strategies"] = append(items(sourceConfig["strategies"]), source)
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"], sourceConfig); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET configuration=jsonb_set(configuration,'{plan,actions}','["strategies.ordinary.configure","strategies.ordinary.publish"]'::jsonb) WHERE endpoint=$1 AND id=$2`, f.Endpoint, taskID); err != nil {
		t.Fatal(err)
	}
	actor, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Actor, error) { return duty.DutyForTaskWithin(ctx, tx, taskID, "query") })
	if err != nil {
		t.Fatal(err)
	}
	operationID := uuid.NewString()
	request := Object{"kind": "ordinary-strategy-create-draft", "sourceStrategyId": sourceID, "sourceVersionId": policy["versionId"], "expectedRevision": 1, "name": "受控新策略", "reason": "沿用获准模板"}
	copyJSON := func(v Object) Object {
		raw, _ := json.Marshal(v)
		var out Object
		_ = json.Unmarshal(raw, &out)
		return out
	}
	deniedSource := copyJSON(sourceConfig)
	obj(obj(items(deniedSource["strategies"])[1])["ordinaryBounds"])["canCreate"] = false
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"], deniedSource); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), request, false); err == nil {
		t.Fatal("unapproved source was accepted")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["versionId"], sourceConfig); err != nil {
		t.Fatal(err)
	}
	badEdit := copyJSON(request)
	badEdit["parameterEdits"] = []any{Object{"path": []any{0}, "value": 100}}
	if _, err = service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), badEdit, false); err == nil {
		t.Fatal("unapproved parameter was accepted")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_heads_v1 SET draft_id=active_id WHERE endpoint=$1`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), request, false); err == nil {
		t.Fatal("existing draft was replaced")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_heads_v1 SET draft_id=NULL WHERE endpoint=$1`, f.Endpoint); err != nil {
		t.Fatal(err)
	}
	stale := copyJSON(request)
	stale["expectedRevision"] = 21
	staleID := uuid.NewString()
	_, err = service.ExecuteDutyOperation(ctx, actor, staleID, stale, false)
	var rejected *operationsautonomy.PreparationRejection
	if !errors.As(err, &rejected) || rejected.Phase() != "prepare" {
		t.Fatalf("stale prepare did not produce pre-dispatch rejection: %v", err)
	}
	var dutyCount, commandCount int
	if err = owner.QueryRow(ctx, `SELECT (SELECT count(*) FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2),(SELECT count(*) FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2)`, f.Endpoint, staleID).Scan(&dutyCount, &commandCount); err != nil || dutyCount != 0 || commandCount != 0 {
		t.Fatalf("preparation had durable effects: duty=%d command=%d err=%v", dutyCount, commandCount, err)
	}
	created, err := service.ExecuteDutyOperation(ctx, actor, operationID, request, false)
	if err != nil {
		t.Fatalf("duty create: %v", err)
	}
	receipt := obj(created["receipt"])
	if created["state"] != "completed" || receipt["sourceStrategyId"] != sourceID || receipt["sourceVersionId"] != policy["versionId"] || !validID(receipt["newStrategyId"]) || receipt["newStrategyId"] == operationID {
		t.Fatalf("create receipt: %v", created)
	}
	versionID, newID := receipt["versionId"], receipt["newStrategyId"]
	artifact, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return strategy.OriginalCreationArtifactWithin(ctx, tx, taskID, str(base["aiAccountId"]), operationID)
	})
	if err != nil || artifact["newStrategyId"] != newID || artifact["sourceVersionId"] != policy["versionId"] {
		t.Fatalf("original artifact: %v %v", artifact, err)
	}
	wrong, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return strategy.OriginalCreationArtifactWithin(ctx, tx, uuid.NewString(), str(base["aiAccountId"]), operationID)
	})
	if err != nil || wrong != nil {
		t.Fatal("artifact disclosed across tasks")
	}
	var originalDuty Object
	if err = owner.QueryRow(ctx, `SELECT result FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, operationID).Scan(&originalDuty); err != nil {
		t.Fatal(err)
	}
	tamperedReceipt := copyJSON(originalDuty)
	obj(tamperedReceipt["receipt"])["newStrategyId"] = uuid.NewString()
	if _, err = owner.Exec(ctx, `UPDATE operations_ai_duty_operations_v1 SET result=$3 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, operationID, tamperedReceipt); err != nil {
		t.Fatal(err)
	}
	wrong, err = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return strategy.OriginalCreationArtifactWithin(ctx, tx, taskID, str(base["aiAccountId"]), operationID)
	})
	if err != nil || wrong != nil {
		t.Fatal("tampered duty receipt exposed an artifact")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_ai_duty_operations_v1 SET result=$3 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, operationID, originalDuty); err != nil {
		t.Fatal(err)
	}
	publish := Object{"kind": "ordinary-strategy-publish", "strategyId": sourceID, "versionId": versionID}
	if _, err = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET enabled=false WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"]); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), publish, false); err == nil {
		t.Fatal("revoked grant was accepted")
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_automation_grants_v1 SET enabled=true WHERE endpoint=$1 AND id=$2`, f.Endpoint, policy["grantId"]); err != nil {
		t.Fatal(err)
	}
	var originalDraft Object
	if err = owner.QueryRow(ctx, `SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2`, f.Endpoint, versionID).Scan(&originalDraft); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"objective", "ordinaryBounds"} {
		tampered := copyJSON(originalDraft)
		strategy := obj(items(tampered["strategies"])[2])
		if field == "objective" {
			strategy[field] = "越权目标"
		} else {
			obj(strategy[field])["canCreate"] = true
		}
		if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, versionID, tampered); err != nil {
			t.Fatal(err)
		}
		if _, err = service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), publish, false); err == nil {
			t.Fatalf("tampered %s was accepted", field)
		}
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, versionID, originalDraft); err != nil {
		t.Fatal(err)
	}
	result, err := service.ExecuteDutyOperation(ctx, actor, uuid.NewString(), publish, false)
	if err != nil {
		t.Fatalf("duty publish: %v", err)
	}
	if result["state"] != "completed" || obj(result["receipt"])["newStrategyId"] != newID {
		t.Fatalf("publish receipt: %v", result)
	}
	recovered, err := service.ExecuteDutyOperation(ctx, actor, operationID, request, true)
	if err != nil || obj(recovered["receipt"])["newStrategyId"] != newID {
		t.Fatalf("original recovery: %v %v", recovered, err)
	}
}
