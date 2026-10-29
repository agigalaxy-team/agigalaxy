package filegovernance_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	files "github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCleanupPlanHumanCardsAndExactOriginalRecoveryPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store := &fixtureStore{dir: t.TempDir()}
	f := operationsfixture.Principals(t, owner, "https://permissions.example.invalid", map[string]string{"root": "R", "writer": "W", "empty": "E"})
	f.Automation(t)
	seed := seedManagedFiles(t, owner, f, store)
	var id string
	for _, v := range seed["rows"].([]any) {
		row := obj(v)
		if row["kind"] == "expired" {
			id = str(row["id"])
		}
	}
	if id == "" {
		t.Fatal("missing expired fixture")
	}
	role, e := f.Permissions.SaveRole(ctx, f.Root, object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Cleanup review", "description": "Isolated cleanup review", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"files.read", "files.cleanup.plan"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "maintenance", object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": obj(role["role"])["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	forum := &community.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now}
	forumFiles := &community.AttachmentService{Forum: forum, Store: store, Scanner: scanner{}, Policy: attachments.DefaultPolicy()}
	source := &files.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, StoredAuthority: f.Gateway.StoredOperators(), PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Forum: forumFiles.GovernanceAdapter(), Now: f.Now}
	candidateResult, e := source.CleanupCandidate(ctx, f.Root, "forum", id)
	if e != nil {
		t.Fatal(e)
	}
	candidate := obj(candidateResult["candidate"])
	if candidate["eligible"] != true {
		t.Fatalf("not eligible: %#v", candidate)
	}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Files: source, Now: f.Now}
	auth := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		read := func(tx pgx.Tx) (p.Actor, error) {
			return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "maintenance", "query", "files.read")
		}
		if tx != nil {
			return read(tx)
		}
		return postgres.InTx(ctx, f.Pool, read)
	}
	run := func(request object) (object, string) {
		t.Helper()
		op := uuid.NewString()
		proposal, e := service.Prepare(ctx, f.Root, "maintenance", request, op)
		if e != nil {
			t.Fatalf("prepare: %v", e)
		}
		got, e := service.ExecutePrepared(ctx, f.Root, proposal, op, auth)
		if e != nil || got["state"] != "completed" {
			t.Fatalf("execute: %#v %v", got, e)
		}
		again, e := service.RecoverPrepared(ctx, f.Root, proposal, op)
		if e != nil || again["state"] != "completed" {
			t.Fatalf("recover: %#v %v", again, e)
		}
		if request["kind"] == "file-cleanup-plan-create" {
			raw, _ := json.Marshal(proposal)
			var forged object
			_ = json.Unmarshal(raw, &forged)
			forged["request"].(map[string]any)["reason"] = "changed"
			forged["command"].(map[string]any)["reason"] = "changed"
			if _, e = service.RecoverPrepared(ctx, f.Root, forged, op); e == nil {
				t.Fatal("original operation accepted changed input")
			}
		}
		return got, op
	}
	created, op := run(object{"kind": "file-cleanup-plan-create", "items": []any{object{"kind": "forum", "id": id, "expectedVersion": candidate["expectedVersion"]}}, "reason": "Original reviewed scope"})
	planID := obj(created["receipt"])["planId"]
	if planID == op {
		t.Fatal("planID must be original receipt ID, not operation ID")
	}
	if store.erasures != 0 {
		t.Fatal("draft creation must not delete")
	}
	run(object{"kind": "file-cleanup-plan-cancel", "targetId": planID, "expectedRevision": 1})
	if store.erasures != 0 {
		t.Fatal("cancel must not delete")
	}
}
