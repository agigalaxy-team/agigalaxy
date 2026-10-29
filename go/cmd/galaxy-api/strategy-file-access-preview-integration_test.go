package main

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestConnectedFileAccessPreviewUsesScopedSourcePG(t *testing.T) {
	ctx := context.Background()
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	account, err := postgres.InTx(ctx, owner, func(tx pgx.Tx) (accounts.Account, error) {
		return (&accounts.Service{Endpoint: f.Endpoint, Now: f.Now}).EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: f.Issuer, ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: f.Now().Add(-time.Hour)})
	})
	if err != nil {
		t.Fatal(err)
	}
	id, digest := uuid.NewString(), identity.Digest([]byte("controlled-file"))
	_, err = owner.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts,scan_result) VALUES($1,$2,$3,'synthetic.txt','text/plain',15,$3,$4,'fixture','available',$5,$6,$5,$6,1,'{"state":"clean"}'::jsonb)`, id, account.ID, digest, "forum-attachments/"+id, f.Now(), f.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	pending := false
	files := &filegovernance.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now, Forum: &filegovernance.FileAdapter{AuthorPending: func(context.Context, pgx.Tx, filegovernance.Object) (bool, error) { return pending, nil }}}
	_, strategy := connectExecutions(f.Gateway, f.Permissions, &operationsautonomy.Service{}, &operationscommunity.Service{}, files, nil, nil, nil)
	read := func() (map[string]any, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (map[string]any, error) {
			return strategy.PreviewObjectWithin(ctx, tx, f.Root, "file-access", id)
		})
	}
	result, err := read()
	if err != nil || result["available"] != true || result["kind"] != "forum-file" || result["version"] == nil {
		t.Fatalf("current scoped source: %#v %v", result, err)
	}
	pending = true
	result, err = read()
	if err != nil || result["available"] != false {
		t.Fatalf("pending author: %#v %v", result, err)
	}
	pending = false
	if _, err = owner.Exec(ctx, `UPDATE forum_attachments_v1 SET expires_at=$2 WHERE id=$1`, id, f.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	result, err = read()
	if err != nil || result["available"] != false {
		t.Fatalf("expired source: %#v %v", result, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE forum_attachments_v1 SET expires_at=$2,purge_pending=true WHERE id=$1`, id, f.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	result, err = read()
	if err != nil || result["available"] != false {
		t.Fatalf("pending purge: %#v %v", result, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE forum_attachments_v1 SET purge_pending=false,revoked_at=$2 WHERE id=$1`, id, f.Now()); err != nil {
		t.Fatal(err)
	}
	result, err = read()
	if err != nil || result["available"] != false {
		t.Fatalf("revoked source: %#v %v", result, err)
	}
	if _, err = owner.Exec(ctx, `UPDATE forum_attachments_v1 SET revoked_at=NULL,purged_at=$2 WHERE id=$1`, id, f.Now()); err != nil {
		t.Fatal(err)
	}
	result, err = read()
	if err != nil || result["available"] != false {
		t.Fatalf("purged source: %#v %v", result, err)
	}
}
