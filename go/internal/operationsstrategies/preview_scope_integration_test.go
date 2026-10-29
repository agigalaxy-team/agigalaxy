package operationsstrategies

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestPreviewChecksEntireSelectedScopePG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	ids := make([]any, 21)
	for i := range ids {
		ids[i] = uuid.NewString()
	}
	last := ids[len(ids)-1].(string)
	strategyID := uuid.NewString()
	configuration := Object{"common": Object{"objective": "goal"}, "domains": []any{Object{"key": "governance", "objective": "goal"}}, "strategies": []any{Object{
		"id": strategyID, "domain": "governance", "objective": "goal", "judgment": "numeric",
		"execution": Object{"aiDomain": "governance", "mode": "human-ai", "trigger": Object{"kind": "manual"}, "grantIds": []any{}, "actions": []any{"content.hide"}, "resourceScope": Object{"kind": "selected", "resourceIds": ids}},
	}}}
	s := &Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PreviewObjectWithin: func(_ context.Context, _ pgx.Tx, _ Actor, _, id string) (Object, error) {
		return Object{"available": id != last, "version": 1}, nil
	}}
	result, err := postgres.InTx(context.Background(), f.Pool, func(tx pgx.Tx) (Object, error) {
		return s.PreviewWithin(context.Background(), tx, configuration, strategyID, f.Root)
	})
	if err != nil {
		t.Fatal(err)
	}
	objects := list(result["objects"])
	if len(objects) != len(ids) || obj(objects[len(objects)-1])["id"] != last || obj(objects[len(objects)-1])["available"] != false || result["valid"] != false {
		t.Fatalf("selected scope was not fully checked: %#v", result)
	}
}
