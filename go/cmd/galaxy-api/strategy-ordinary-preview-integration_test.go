package main

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type deniedStrategyReader struct{ p.Authority }

func (d deniedStrategyReader) RequireWithin(ctx context.Context, tx pgx.Tx, a p.Actor, action string) (p.Actor, error) {
	if action == "strategies.read" {
		return p.Actor{}, fault.New("denied", 403)
	}
	return d.Authority.RequireWithin(ctx, tx, a, action)
}

func TestPreviewOrdinaryStrategyUsesCurrentAuthorizedSourcePG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	ctx := context.Background()
	id, versionID := uuid.NewString(), uuid.NewString()
	strategy := map[string]any{"id": id, "mode": "ai-autonomous", "ordinaryBounds": map[string]any{"canCreate": true}}
	config := map[string]any{"strategies": []any{strategy}}
	_, err := owner.Exec(ctx, `INSERT INTO operations_p13_strategy_versions_v1(id,endpoint,version,configuration,created_by,created_at) VALUES($1,$2,1,$3,$4,$5)`, versionID, f.Endpoint, config, f.Root.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO operations_p13_strategy_heads_v1(endpoint,revision,active_id,paused,updated_at) VALUES($1,9,$2,true,$3)`, f.Endpoint, versionID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	service := &operationsstrategies.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway}
	read := func(target string) (operationsstrategies.Object, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationsstrategies.Object, error) {
			return previewOrdinaryStrategy(ctx, tx, f.Root, target, service.InspectOrdinaryWithin)
		})
	}
	result, err := read(id)
	if err != nil || result["available"] != true || result["version"] != versionID {
		t.Fatalf("current source: %#v %v", result, err)
	}
	if _, err = read(uuid.NewString()); fault.Status(err) != 404 {
		t.Fatalf("missing source: %v", err)
	}
	for _, test := range []struct {
		mode   string
		bounds any
	}{{"ai-autonomous", nil}, {"human-led", map[string]any{}}} {
		strategy["mode"], strategy["ordinaryBounds"] = test.mode, test.bounds
		if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_versions_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2`, f.Endpoint, versionID, config); err != nil {
			t.Fatal(err)
		}
		result, err = read(id)
		if err != nil || result["available"] != false {
			t.Fatalf("unqualified source: %#v %v", result, err)
		}
	}
	service.Authority = deniedStrategyReader{f.Gateway}
	if _, err = read(id); fault.Status(err) != 403 {
		t.Fatalf("revoked strategies.read: %v", err)
	}
}
