package operationsqueries_test

import (
	"context"
	"testing"

	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	q "github.com/agigalaxy-team/agigalaxy/go/internal/operationsqueries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestStrategyVersionRehearsalsReachFixedAIQueryPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	role, e := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Rehearsal reader", "description": "Synthetic reader", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"strategies.read"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	strategy := &operationsstrategies.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	draft, e := strategy.SaveDraft(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": operationsstrategies.EmptyConfiguration(), "reason": "Original draft"}, func() (p.Actor, error) { return f.Root, nil })
	if e != nil {
		t.Fatal(e)
	}
	id := draft["versionId"].(string)
	op := uuid.NewString()
	if _, e = strategy.Rehearsal(ctx, f.Root, map[string]any{"operationId": op, "versionId": id, "executionIds": []any{}}); e != nil {
		t.Fatal(e)
	}
	s := &q.Service{Pool: f.Pool, Permissions: f.Permissions, Strategies: strategy, Now: f.Now}
	result, e := s.Query(ctx, f.Root, "overview", "read-operation-object", map[string]any{"kind": "strategy-version", "id": id, "filters": map[string]any{"limit": 1}})
	if e != nil {
		t.Fatal(e)
	}
	data := result["data"].(map[string]any)
	page := data["rehearsals"].(map[string]any)
	items := page["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["rehearsalId"] != op || result["pagination"].(map[string]any)["complete"] != true {
		t.Fatalf("query projection %#v", result)
	}
}
