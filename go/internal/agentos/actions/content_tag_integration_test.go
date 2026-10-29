package actions_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestContentTagHumanCardsAndExactOriginalRecoveryPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, e := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Tag review", "description": "Isolated tag review", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"content.tags.read", "content.tags.manage"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "governance", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	source := &operationscommunity.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Content: source, Now: f.Now}
	auth := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		read := func(tx pgx.Tx) (p.Actor, error) {
			return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "governance", "query", "content.tags.read")
		}
		if tx != nil {
			return read(tx)
		}
		return postgres.InTx(ctx, f.Pool, read)
	}
	run := func(request map[string]any) (map[string]any, string) {
		t.Helper()
		op := uuid.NewString()
		proposal, e := service.Prepare(ctx, f.Root, "governance", request, op)
		if e != nil {
			t.Fatalf("prepare: %v", e)
		}
		got, e := service.ExecutePrepared(ctx, f.Root, proposal, op, auth)
		if e != nil || got["state"] != "completed" {
			t.Fatalf("execute: %#v %v", got, e)
		}
		recovered, e := service.RecoverPrepared(ctx, f.Root, proposal, op)
		if e != nil || recovered["state"] != "completed" {
			t.Fatalf("recover: %#v %v", recovered, e)
		}
		raw, _ := json.Marshal(proposal)
		var forged map[string]any
		_ = json.Unmarshal(raw, &forged)
		forged["request"].(map[string]any)["name"] = "changed intent"
		forged["command"].(map[string]any)["name"] = "changed intent"
		if _, e = service.RecoverPrepared(ctx, f.Root, forged, op); e == nil {
			t.Fatal("changed request must not recover original tag operation")
		}
		return got, op
	}
	created, op := run(map[string]any{"kind": "content-tag-create", "name": "真实标签"})
	id := created["receipt"].(map[string]any)["tagId"]
	if id == op {
		t.Fatal("tag ID must come from result, not operation ID")
	}
	updated, _ := run(map[string]any{"kind": "content-tag-update", "targetId": id, "expectedVersion": 1, "name": "调整名称", "enabled": false})
	if updated["receipt"].(map[string]any)["enabled"] != false {
		t.Fatal("tag disable not reflected in original receipt")
	}
}
