package operationspermissions_test

import (
	"context"
	"testing"

	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestFileAccessPreparationProofBoundary(t *testing.T) {
	ctx := context.Background()
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	accounts := object(f.Automation(t)["accounts"])
	role, err := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "File action test", "description": "Fixture", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"files.read", "files.access.stop", "files.access.restore"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "governance", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": object(role["role"])["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	tx, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	account := text(accounts["governance"])
	portal, err := f.Permissions.HumanAIAccountReadWithin(ctx, tx, f.Root, "governance", account, "prepare", "files.read")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := f.Permissions.StoredHumanAIWithin(ctx, tx, f.Root.ID, "governance", account, "prepare", "files.read")
	if err != nil {
		t.Fatal(err)
	}
	reader := f.Permissions.PreparationReader()
	if !perms.FileAccessPreparationReaderMatches(reader, portal) || !perms.FileAccessPreparationReaderMatches(reader, stored) {
		t.Fatal("valid preparation source rejected")
	}
	if _, err = perms.RequireConfirmedFileAccessWithin(ctx, tx, reader, stored, portal, "files.access.stop"); err != nil {
		t.Fatal("portal confirmation", err)
	}
	if _, err = perms.RequireConfirmedFileAccessWithin(ctx, tx, reader, portal, stored, "files.access.stop"); err == nil {
		t.Fatal("stored confirmation accepted")
	}
	if _, err = perms.RequireConfirmedFileAccessWithin(ctx, tx, reader, stored, portal, "files.cleanup.approve"); err == nil {
		t.Fatal("unrelated action accepted")
	}
	if perms.FileAccessPreparationReaderMatches(fakeReceiptReader{f.Gateway}, portal) {
		t.Fatal("fake reader accepted")
	}
	forged := portal
	forged.AIProof = nil
	if perms.FileAccessPreparationReaderMatches(reader, forged) {
		t.Fatal("forged proof accepted")
	}
	if _, err = tx.Exec(ctx, `UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE id=$1`, account); err != nil {
		t.Fatal(err)
	}
	if _, err = perms.RequireConfirmedFileAccessWithin(ctx, tx, reader, stored, portal, "files.access.stop"); err == nil {
		t.Fatal("AI revocation ignored on subsequent same-transaction check")
	}
}
