package actions_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestMessageDraftReviewOriginalRecoveryPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, err := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Message review", "description": "Isolated test", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"notices.read", "notices.create", "notices.update"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "messaging", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); err != nil {
		t.Fatal(err)
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
	config := map[string]any{"channels": []any{"inapp"}, "content": map[string]any{"purpose": "service-update", "title": "Title", "body": "Body", "href": nil, "expiresAt": "2099-01-01T00:00:00Z"}, "audience": map[string]any{"kind": "all-accounts"}, "schedule": map[string]any{"kind": "immediate"}, "senderKey": "notice"}
	run := func(req map[string]any) string {
		t.Helper()
		op := uuid.NewString()
		proposal, err := service.Prepare(ctx, f.Root, "messaging", req, op)
		if err != nil {
			t.Fatalf("prepare: %v", err)
		}
		raw, _ := json.Marshal(proposal)
		var old map[string]any
		if err := json.Unmarshal(raw, &old); err != nil {
			t.Fatal(err)
		}
		old["impact"] = []any{"仅保存草稿"}
		if _, err := service.ExecutePrepared(ctx, f.Root, old, op, auth); fault.Code(err) != "operations_agentos_review_changed" {
			t.Fatalf("old review: %v", err)
		}
		var count int
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op).Scan(&count); err != nil || count != 0 {
			t.Fatalf("old card wrote command: %d %v", count, err)
		}
		result, err := service.ExecutePrepared(ctx, f.Root, proposal, op, auth)
		if err != nil || result["state"] != "completed" {
			t.Fatalf("execute: %#v %v", result, err)
		}
		recovered, err := service.ExecutePrepared(ctx, f.Root, old, op, auth)
		if err != nil || recovered["state"] != "completed" {
			t.Fatalf("original recovery: %#v %v", recovered, err)
		}
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op).Scan(&count); err != nil || count != 1 {
			t.Fatalf("original operation count: %d %v", count, err)
		}
		return op
	}
	id := run(map[string]any{"kind": "message-draft-create", "config": config})
	run(map[string]any{"kind": "message-draft-save", "targetId": id, "config": config})
}
