package operationspermissions_test

import (
	"context"
	"testing"

	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

type fakeReceiptReader struct{ perms.Authority }

func (fakeReceiptReader) AcceptsQuery(perms.Actor) bool { return true }

func TestOriginalReceiptQueryAuthorityBoundaries(t *testing.T) {
	ctx := context.Background()
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	accounts := object(f.Automation(t)["accounts"])
	role, e := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Receipt read test", "description": "Fixture", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"autonomy.read", "content.read"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "governance", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": object(role["role"])["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	tx, e := owner.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	account := text(accounts["governance"])
	for _, stored := range []bool{false, true} {
		var query perms.Actor
		if stored {
			var conversation perms.Actor
			conversation, e = f.Permissions.StoredHumanAIWithin(ctx, tx, f.Root.ID, "governance", account, "conversation", "workbench.read")
			if e == nil {
				query, e = f.Permissions.HumanAIAccountReadWithin(ctx, tx, conversation, "governance", account, "query", "autonomy.read")
			}
		} else {
			query, e = f.Permissions.HumanAIAccountReadWithin(ctx, tx, f.Root, "governance", account, "query", "autonomy.read")
		}
		if e != nil {
			t.Fatal(e)
		}
		for _, permission := range []string{"feedback.read", "content.read"} {
			result, err := f.Permissions.WithOriginalAIReceiptReadWithin(ctx, tx, query, permission, func(a perms.Actor, authority perms.Authority) (perms.Object, error) {
				if !perms.OriginalAIReceiptQueryReaderMatches(authority, a) || a.AIProof == nil || a.ID != f.Root.ID {
					t.Fatal("query proof lost")
				}
				return perms.Object{"ok": true}, nil
			})
			if err != nil || result["ok"] != true {
				t.Fatalf("stored=%v permission=%s result=%v err=%v", stored, permission, result, err)
			}
		}
		if _, err := f.Permissions.WithOriginalAIReceiptReadWithin(ctx, tx, query, "feedback.update", func(perms.Actor, perms.Authority) (perms.Object, error) {
			t.Fatal("write entered callback")
			return nil, nil
		}); err == nil {
			t.Fatal("write permission accepted")
		}
		forged := query
		forged.AIProof = nil
		if _, err := f.Permissions.WithOriginalAIReceiptReadWithin(ctx, tx, forged, "feedback.read", func(perms.Actor, perms.Authority) (perms.Object, error) {
			t.Fatal("forged proof entered")
			return nil, nil
		}); err == nil {
			t.Fatal("forged proof accepted")
		}
	}
	query, e := f.Permissions.HumanAIAccountReadWithin(ctx, tx, f.Root, "governance", account, "query", "autonomy.read")
	if e != nil {
		t.Fatal(e)
	}
	if perms.OriginalAIReceiptQueryReaderMatches(f.Gateway, query) {
		t.Fatal("ordinary authority accepted as query reader")
	}
	if perms.OriginalAIReceiptQueryReaderMatches(fakeReceiptReader{f.Gateway}, query) {
		t.Fatal("forged query reader accepted")
	}
	prepare, e := f.Permissions.HumanAIWithin(ctx, tx, f.Root, "governance", "prepare", "feedback.read")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.WithOriginalAIReceiptReadWithin(ctx, tx, prepare, "feedback.read", func(perms.Actor, perms.Authority) (perms.Object, error) { t.Fatal("prepare entered"); return nil, nil }); e == nil {
		t.Fatal("prepare proof accepted")
	}
	_, e = f.Permissions.WithOriginalAIReceiptReadWithin(ctx, tx, query, "feedback.read", func(perms.Actor, perms.Authority) (perms.Object, error) {
		_, err := tx.Exec(ctx, `UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE id=$1`, account)
		return perms.Object{"ok": true}, err
	})
	if e == nil {
		t.Fatal("AI revocation during callback was not rechecked")
	}
}
