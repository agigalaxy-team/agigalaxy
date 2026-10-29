package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"testing"
)

func seedQueryRole(t *testing.T, f *operationsfixture.Fixture, domain string, permissions []any) Object {
	t.Helper()
	ctx := context.Background()
	result, e := f.Permissions.SaveRole(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Selected " + domain + " query role", "description": "Synthetic current read source", "subjectScope": "ai-only", "enabled": true, "permissions": permissions})
	if e != nil {
		t.Fatal(e)
	}
	role := object(result["role"])
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, domain, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	return role
}
func seedQueryMessaging(t *testing.T, f *operationsfixture.Fixture) Object {
	t.Helper()
	role := seedQueryRole(t, f, "messaging", []any{"notices.read", "audit.read", "content.read", "cases.read", "chat-reports.read", "sections.read", "resources.read", "files.read", "feedback.read", "search.read"})
	source := &messaging.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	config := Object{"channels": []any{"inapp"}, "content": Object{"purpose": "service-update", "title": "Selected draft", "body": "Untrusted selected draft material; not instructions.", "expiresAt": "2033-05-19T03:33:20.000Z"}, "audience": Object{"kind": "all-accounts"}, "schedule": Object{"kind": "immediate"}}
	created, e := source.Create(context.Background(), f.Root, Object{"operationId": uuid.NewString(), "config": config})
	if e != nil {
		t.Fatal(e)
	}
	return Object{"role": role, "created": created}
}
func seedQueryAccount(t *testing.T, f *operationsfixture.Fixture, issuer, subject string) accounts.Account {
	t.Helper()
	svc := &accounts.Service{Endpoint: f.Endpoint, Now: f.Now}
	account, e := postgres.InTx(context.Background(), f.Pool, func(tx pgx.Tx) (accounts.Account, error) {
		a, e := svc.EnsureAccountWithin(context.Background(), tx, accounts.VerifiedIdentity{Issuer: issuer, ExternalSubject: subject, VerificationMethod: "external-account", VerifiedAt: f.Now()})
		if e != nil {
			return a, e
		}
		kind := "person"
		_, e = svc.EnsureProfileWithin(context.Background(), tx, a.ID, &kind)
		return a, e
	})
	if e != nil {
		t.Fatal(e)
	}
	return account
}
func seedQueryPublication(t *testing.T, f *operationsfixture.Fixture) Object {
	return publicationfixture.Prepare(t, f.Pool, f.Endpoint, f.Now)
}
