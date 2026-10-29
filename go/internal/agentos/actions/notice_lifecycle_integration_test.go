package actions_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestIndependentNoticeDraftAndExactOriginalRecoveryPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, e := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Independent notices", "description": "Isolated notice test", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"notices.read", "notices.create", "notices.update", "notices.withdraw"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "messaging", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	source := &messaging.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Messaging: source, Now: f.Now}
	auth := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		read := func(tx pgx.Tx) (p.Actor, error) {
			return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "messaging", "query", "notices.read")
		}
		if tx != nil {
			return read(tx)
		}
		return postgres.InTx(ctx, f.Pool, read)
	}
	content := map[string]any{"purpose": "service-update", "title": "Review title", "body": "Review body", "href": nil, "audience": map[string]any{"kind": "all-accounts"}, "expiresAt": "2099-01-01T00:00:00Z"}
	run := func(request map[string]any) (map[string]any, string) {
		t.Helper()
		op := uuid.NewString()
		proposal, e := service.Prepare(ctx, f.Root, "messaging", request, op)
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
		if request["kind"] == "notice-draft-create" {
			raw, _ := json.Marshal(proposal)
			var forged map[string]any
			_ = json.Unmarshal(raw, &forged)
			forged["request"].(map[string]any)["content"].(map[string]any)["body"] = "changed intent"
			forged["command"].(map[string]any)["content"].(map[string]any)["body"] = "changed intent"
			if _, e = service.RecoverPrepared(ctx, f.Root, forged, op); e == nil {
				t.Fatal("original operation must reject altered content")
			}
		}
		return got, op
	}
	created, id := run(map[string]any{"kind": "notice-draft-create", "content": content})
	if created["receipt"].(map[string]any)["noticeId"] != id {
		t.Fatal("create target is original operation ID")
	}
	content["body"] = "Updated review body"
	run(map[string]any{"kind": "notice-draft-save", "targetId": id, "expectedVersion": 1, "content": content})
	run(map[string]any{"kind": "notice-state", "targetId": id, "expectedVersion": 2, "action": "withdraw"})
}
