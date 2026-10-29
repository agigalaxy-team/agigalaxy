// Package publicationfixture creates a synthetic, genuinely authorized account
// and a prepared public forum payload; the caller performs the real publish.
package publicationfixture

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
	"time"
)

func Prepare(t *testing.T, pool *pgxpool.Pool, endpoint string, now func() time.Time) map[string]any {
	t.Helper()
	ctx := context.Background()
	if _, e := pool.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3) ON CONFLICT DO NOTHING`, endpoint, operationsrules.EmptyControls(), now()); e != nil {
		t.Fatal(e)
	}
	svc := &accounts.Service{Endpoint: endpoint, Now: now}
	account, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (accounts.Account, error) {
		a, e := svc.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: "https://login.example.invalid", ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: now()})
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
	if _, e = pool.Exec(ctx, "UPDATE official_account_profiles_v1 SET display_name='Synthetic publication account',query_enabled=false WHERE account_id=$1", account.ID); e != nil {
		t.Fatal(e)
	}
	payload := community.Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": account.ID, "postId": uuid.NewString(), "versionId": uuid.NewString(), "expectedHeadVersion": 0, "title": "Synthetic public activity", "body": "Only this public source is counted.", "links": []any{}, "attachments": []any{}, "topic": "technology", "publishedUntil": now().Add(time.Hour).Unix()}
	community.BindCreatePostIDs(account.ID, payload)
	return map[string]any{"accounts": []any{account.ID}, "payload": payload}
}
