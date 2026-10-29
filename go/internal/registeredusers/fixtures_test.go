package registeredusers_test

import (
	"context"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func registeredFixture(t *testing.T, pool *pgxpool.Pool) object {
	t.Helper()
	ctx := context.Background()
	management := operationsfixture.Principals(t, pool, "https://registered.example.invalid", map[string]string{"root": "R"})
	if _, err := databaseschema.Migrate(ctx, pool, []string{"worker"}); err != nil {
		t.Fatal(err)
	}
	issuer := "https://website.example.invalid/realms/website"
	profile := &accounts.Service{Endpoint: management.Endpoint, Now: management.Now}
	created := map[string]accounts.Account{}
	for _, subject := range []string{"formed", "legacy"} {
		account, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (accounts.Account, error) {
			value, err := profile.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: issuer, ExternalSubject: subject, VerificationMethod: "external-account", VerifiedAt: management.Now()})
			if err != nil {
				return value, err
			}
			kind := "person"
			_, err = profile.EnsureProfileWithin(ctx, tx, value.ID, &kind)
			return value, err
		})
		if err != nil {
			t.Fatal(err)
		}
		created[subject] = account
	}
	if _, err := pool.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$2,$3,$4,'formed','formed@example.invalid',true,$5,2000000000,$6)`, strings.Repeat("a", 64), strings.Repeat("d", 64), created["formed"].ID, issuer, strings.Repeat("E", 43), management.Now().Unix()+3600); err != nil {
		t.Fatal(err)
	}
	return object{"endpoint": management.Endpoint, "issuer": issuer, "management": management.Issuer, "operatorId": management.Root.ID}
}
