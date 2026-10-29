package filegovernance_test

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
	"time"
)

func seedManagedFiles(t *testing.T, owner *pgxpool.Pool, f *operationsfixture.Fixture, store *fixtureStore) object {
	t.Helper()
	ctx := context.Background()
	now := f.Now()
	if _, err := databaseschema.Migrate(ctx, owner, []string{"worker"}); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.InTx(ctx, owner, func(tx pgx.Tx) (bool, error) {
		if err := objectremoval.MigrateWithin(ctx, tx); err != nil {
			return false, err
		}
		return true, objectremoval.ProvisionRolesWithin(ctx, tx)
	}); err != nil {
		t.Fatal(err)
	}
	codes := []any{"files.read", "files.scan.retry", "files.access.stop", "files.access.restore", "files.cleanup.plan", "files.cleanup.approve"}
	roleResult, err := f.Permissions.SaveRole(ctx, f.Root, object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "File maintainer", "description": "Synthetic file authority", "enabled": true, "permissions": codes})
	if err != nil {
		t.Fatal(err)
	}
	role := obj(roleResult["role"])
	if _, err = f.Permissions.SaveAssignment(ctx, f.Root, object{"operationId": uuid.NewString(), "expectedVersion": 0, "operatorId": f.IDs["writer"], "roleId": role["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	a, err := postgres.InTx(ctx, owner, func(tx pgx.Tx) (accounts.Account, error) {
		svc := &accounts.Service{Endpoint: f.Endpoint, Now: f.Now}
		return svc.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: f.Issuer, ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: now.Add(-10000 * time.Second)})
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := []any{}
	for _, kind := range []string{"expired", "available", "scan"} {
		id := uuid.NewString()
		data := []byte("Synthetic managed bytes " + id)
		key := "forum-attachments/" + id
		hash := identity.Digest(data)
		if err = store.Put(ctx, key, data, hash); err != nil {
			t.Fatal(err)
		}
		expires := now.Add(time.Hour)
		if kind == "expired" {
			expires = now.Add(-time.Second)
		}
		state := "available"
		var scan any = object{"state": "clean", "checkedAt": now.Unix() - 1}
		var last any
		if kind == "scan" {
			state = "scan-pending"
			scan = nil
			last = "attachment_scan_failed"
		}
		if _, err = owner.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts,scan_result,last_error) VALUES($1,$2,$3,$4,'text/plain',$5,$3,$6,'isolated-managed-key',$7,$8,$9,$8,$9,1,$10,$11)`, id, a.ID, hash, "原文件 "+kind+" 🚀", len(data), key, state, now, expires, scan, last); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, object{"id": id, "kind": kind, "key": key, "hash": hash, "size": len(data)})
	}
	return object{"rows": rows, "role": role, "codes": codes, "account": a.ID}
}
