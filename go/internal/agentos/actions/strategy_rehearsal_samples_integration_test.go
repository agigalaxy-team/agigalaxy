package actions_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func rehearsalImpact(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestRehearsalSamplesAreCheckedBeforeCardPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, err := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Sample reviewer", "description": "Review samples", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"strategies.read", "strategies.configure"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	target := uuid.NewString()
	grant, err := f.Permissions.SaveAutomation(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Sample grant", "executorKind": "program", "mode": "assisted", "enabled": true, "permissions": []any{"content.read", "content.hide", "content.restore"}, "resourceIds": []any{target}})
	if err != nil {
		t.Fatal(err)
	}
	automation := grant["automation"].(map[string]any)
	executions := &agentos.Executions{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	created, err := executions.Create(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "grantId": automation["id"], "expectedGrantVersion": automation["version"], "domain": "governance", "actions": []any{"content.read", "content.hide", "content.restore"}, "resourceIds": []any{target}, "preparedCommand": map[string]any{"tool": "content-visibility", "targetKind": "post", "targetId": target, "input": map[string]any{"expectedVersion": 1, "expectedRevision": 0, "kind": "hide", "until": f.Now().Unix() + 600, "reason": "Reviewed sample"}}}, func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		return f.Gateway.RequireWithin(ctx, tx, f.Root, "workbench.read")
	})
	if err != nil {
		t.Fatal(err)
	}
	execution := created["executionId"].(string)
	strategy := &operationsstrategies.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now, Effects: &operationsstrategies.EffectsAdapter{Executions: executions}}
	draft, err := strategy.SaveDraft(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": operationsstrategies.EmptyConfiguration(), "reason": "Reviewed configuration"}, func() (p.Actor, error) { return f.Root, nil })
	if err != nil {
		t.Fatal(err)
	}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Strategies: strategy, Now: f.Now}
	prepare := func(ids []any) (map[string]any, error) {
		return service.Prepare(ctx, f.Root, "overview", map[string]any{"kind": "strategy-rehearsal", "versionId": draft["versionId"], "executionIds": ids}, uuid.NewString())
	}
	proposal, err := prepare([]any{execution})
	if err != nil || proposal == nil {
		t.Fatalf("valid current sample: %v %#v", err, proposal)
	}
	if !strings.Contains(strings.TrimSpace(rehearsalImpact(t, proposal["impact"])), execution) {
		t.Fatal("sample missing from human review")
	}
	if proposal, err = prepare([]any{uuid.NewString()}); proposal != nil || fault.Code(err) != "operations_agentos_execution_inactive" {
		t.Fatalf("wrong turn generated card: %#v %v", proposal, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_executions_v1 SET created_by=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, execution, f.IDs["writer"]); err != nil {
		t.Fatal(err)
	}
	if proposal, err = prepare([]any{execution}); proposal != nil || fault.Code(err) != "p13_execution_not_found" {
		t.Fatalf("other owner generated card: %#v %v", proposal, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_executions_v1 SET created_by=$3,state='stopped' WHERE endpoint=$1 AND id=$2`, f.Endpoint, execution, f.Root.ID); err != nil {
		t.Fatal(err)
	}
	if proposal, err = prepare([]any{execution}); proposal != nil || fault.Code(err) != "operations_agentos_execution_inactive" {
		t.Fatalf("stopped execution generated card: %#v %v", proposal, err)
	}
	if proposal, err = prepare([]any{}); err != nil || proposal == nil || !strings.Contains(rehearsalImpact(t, proposal["impact"]), "未选择外部执行样本") {
		t.Fatalf("empty sample: %#v %v", proposal, err)
	}
}
