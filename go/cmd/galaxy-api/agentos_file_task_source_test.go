package main

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type noFileRead struct{ p.Authority }

func (a noFileRead) RequireWithin(ctx context.Context, tx pgx.Tx, actor p.Actor, permission string) (p.Actor, error) {
	if permission == "files.read" {
		return p.Actor{}, fault.New("operations_permission_denied", 403)
	}
	return a.Authority.RequireWithin(ctx, tx, actor, permission)
}

func TestFileTargetTaskDetailUsesProductionSourceWiring(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	account, err := postgres.InTx(ctx, owner, func(tx pgx.Tx) (accounts.Account, error) {
		return (&accounts.Service{Endpoint: f.Endpoint, Now: f.Now}).EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: f.Issuer, ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: f.Now()})
	})
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	hash := identity.Digest([]byte("synthetic file"))
	at := f.Now()
	if _, err = owner.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_attempts) VALUES($1,$2,$3,'Synthetic','text/plain',14,$3,$4,'fixture-key','available',$5,$6,$5,$6,0)`, id, account.ID, hash, "forum-attachments/"+id, at, at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	autonomy := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	files := &filegovernance.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now}
	connectWorkbenchActions(&agentos.Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Tools: &agentos.ConversationTools{}}, autonomy, nil, files)
	taskID := uuid.NewString()
	targetType := "file-forum"
	_, err = postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (map[string]any, error) {
		return autonomy.LinkWorkbenchWithin(ctx, tx, operationsautonomy.WorkbenchLink{OperationID: taskID, Domain: "overview", AIAccountID: automation["accounts"].(map[string]any)["overview"].(string), TargetType: &targetType, TargetID: &id})
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := autonomy.GetTask(ctx, f.Root, taskID)
	if err != nil || result["task"] == nil {
		t.Fatalf("selected file task %#v %v", result, err)
	}
	autonomy.Authority = noFileRead{Authority: f.Gateway}
	if _, err = autonomy.GetTask(ctx, f.Root, taskID); fault.Status(err) != 403 {
		t.Fatalf("revoked file authority: %v", err)
	}
}
