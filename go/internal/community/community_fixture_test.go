package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
	"time"
)

func seedCommunity(t *testing.T, pool *pgxpool.Pool) Object {
	t.Helper()
	ctx := context.Background()
	endpoint := "https://go-community.example.invalid"
	at := time.Unix(2000000000, 0)
	if _, e := databaseschema.Migrate(ctx, pool, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		if e := objectremoval.MigrateWithin(ctx, tx); e != nil {
			return false, e
		}
		return true, objectremoval.ProvisionRolesWithin(ctx, tx)
	}); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3)`, endpoint, controls(), at); e != nil {
		t.Fatal(e)
	}
	ids := []any{}
	svc := &accounts.Service{Endpoint: endpoint, Now: func() time.Time { return at }}
	for _, name := range []string{"社区甲", "社区乙"} {
		a, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (accounts.Account, error) {
			a, e := svc.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: "https://login.example.invalid", ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: at})
			if e != nil {
				return a, e
			}
			kind := "person"
			_, e = svc.EnsureProfileWithin(ctx, tx, a.ID, &kind)
			return a, e
		})
		if e != nil {
			t.Fatal(e)
		}
		if _, e = pool.Exec(ctx, "UPDATE official_account_profiles_v1 SET display_name=$2,query_enabled=false WHERE account_id=$1", a.ID, name); e != nil {
			t.Fatal(e)
		}
		ids = append(ids, a.ID)
	}
	account := ids[0].(string)
	attachmentID := uuid.NewString()
	hash := "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	if _, e := pool.Exec(ctx, `INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_result) VALUES($1,$2,$3,'原附件.txt','text/plain',18,$3,$4,'fixture-key','available',$5,$6,$5,$6,'{"state":"clean"}')`, attachmentID, account, hash, "forum-attachments/"+attachmentID, at, at.Add(time.Hour)); e != nil {
		t.Fatal(e)
	}
	payload := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": account, "postId": uuid.NewString(), "versionId": uuid.NewString(), "expectedHeadVersion": 0, "title": "银河社区迁移", "body": "原帖文字与权限保持。", "links": []any{}, "attachments": []any{Object{"id": attachmentID, "sha256": hash}}, "topic": "technology", "publishedUntil": int64(2000003600)}
	BindCreatePostIDs(account, payload)
	return Object{"endpoint": endpoint, "accounts": ids, "payload": payload}
}
