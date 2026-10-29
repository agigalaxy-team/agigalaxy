package accounts

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
	"time"
)

const fixtureEndpoint = "https://accounts.example.invalid"
const fixtureIssuer = "https://login.example.invalid"

func initializeAccounts(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, e := databaseschema.Migrate(context.Background(), pool, []string{"api"}); e != nil {
		t.Fatal(e)
	}
}
func createTestAccount(t *testing.T, pool *pgxpool.Pool, service *Service, subject string) Account {
	t.Helper()
	ctx := context.Background()
	account, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Account, error) {
		return service.EnsureAccountWithin(ctx, tx, VerifiedIdentity{Issuer: fixtureIssuer, ExternalSubject: subject, VerificationMethod: "email", VerifiedAt: time.Unix(2000000000, 0)})
	})
	if e != nil {
		t.Fatal(e)
	}
	kind := "person"
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Profile, error) { return service.EnsureProfileWithin(ctx, tx, account.ID, &kind) }); e != nil {
		t.Fatal(e)
	}
	return account
}
