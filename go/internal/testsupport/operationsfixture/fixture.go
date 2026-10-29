// Package operationsfixture prepares synthetic management identities and roles
// through the current Go schema and permission commands in a disposable test DB.
package operationsfixture

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Fixture struct {
	owner            *pgxpool.Pool
	Data             Object
	Pool             *pgxpool.Pool
	Gateway          *access.Gateway
	Permissions      *operationspermissions.Service
	Root             operationspermissions.Actor
	Endpoint, Issuer string
	IDs              map[string]string
	Now              func() time.Time
}

type directory struct{}

func (directory) Roles(_ context.Context, _ string, subject string) ([]string, error) {
	if subject == "root" || subject == "writer" {
		return []string{"admit-admin"}, nil
	}
	return []string{"admit-reader"}, nil
}
func (d directory) RolesFresh(ctx context.Context, issuer, subject string) ([]string, error) {
	return d.Roles(ctx, issuer, subject)
}

func New(t *testing.T, owner *pgxpool.Pool) *Fixture {
	t.Helper()
	return NewEndpoint(t, owner, "https://permissions.example.invalid")
}

func Principals(t *testing.T, owner *pgxpool.Pool, endpoint string, principals map[string]string) *Fixture {
	t.Helper()
	ctx := context.Background()
	f := &Fixture{owner: owner, Endpoint: endpoint, Issuer: "https://management.example.invalid/realms/management", IDs: map[string]string{}, Now: func() time.Time { return time.Unix(2000000000, 0) }}
	if _, err := databaseschema.Migrate(ctx, owner, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	for name, marker := range principals {
		id := identity.Digest([]byte(f.Issuer + "\x00" + name))
		f.IDs[name] = id
		if _, err := owner.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)`, id, f.Endpoint, f.Issuer, name, "Synthetic "+name, f.Now()); err != nil {
			t.Fatal(err)
		}
		role := "reader"
		if name == "root" {
			role = "administrator"
		}
		if _, err := owner.Exec(ctx, `INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, f.Endpoint, strings.Repeat("b", 64), identity.Digest([]byte(strings.Repeat(marker, 43))), id, f.Issuer, name, "Synthetic "+name, role, strings.Repeat("C", 43), f.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, connection *pgx.Conn) error {
		_, err := connection.Exec(ctx, "SET ROLE galaxy_api")
		return err
	}
	var err error
	f.Pool, err = pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Pool.Close)
	f.Gateway, err = access.New(f.Pool, access.Config{Endpoint: f.Endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: f.Issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: f.IDs["root"], Issuer: f.Issuer, Subject: "root"}}, directory{})
	if err != nil {
		t.Fatal(err)
	}
	f.Gateway.Now = f.Now
	request := httptest.NewRequest("POST", "https://admin.example.invalid/v1/operations/permissions/roles/save", nil)
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	f.Root, err = f.Gateway.AuthorizeOperations(request, true, "")
	if err != nil {
		t.Fatal(err)
	}
	f.Permissions = &operationspermissions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, StoredAuthority: f.Gateway, Now: f.Now, AIWork: &operationsai.Service{Endpoint: f.Endpoint}}
	ids := Object{}
	for name, id := range f.IDs {
		ids[name] = id
	}
	f.Data = Object{"endpoint": f.Endpoint, "issuer": f.Issuer, "ids": ids}
	return f
}

func NewEndpoint(t *testing.T, owner *pgxpool.Pool, endpoint string) *Fixture {
	t.Helper()
	f := Principals(t, owner, endpoint, map[string]string{"root": "R", "writer": "W", "empty": "E"})
	ctx := context.Background()
	writer, err := f.Permissions.SaveRole(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Writer", "description": "Synthetic delegated human role", "enabled": true, "permissions": []any{"permissions.read", "permissions.roles.write", "permissions.assignments.write", "feedback.read"}})
	if err != nil {
		t.Fatal(err)
	}
	writerRole := writer["role"].(map[string]any)
	assignment, err := f.Permissions.SaveAssignment(ctx, f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "operatorId": f.IDs["writer"], "roleId": writerRole["id"], "enabled": true})
	if err != nil {
		t.Fatal(err)
	}
	originalInput := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": " Original role ", "description": " Original JS role ", "enabled": true, "permissions": []any{"feedback.read"}}
	original, err := f.Permissions.SaveRole(ctx, f.Root, originalInput)
	if err != nil {
		t.Fatal(err)
	}
	ids := Object{}
	for name, id := range f.IDs {
		ids[name] = id
	}
	f.Data = Object{"endpoint": f.Endpoint, "issuer": f.Issuer, "ids": ids, "writerRole": writerRole, "assignment": assignment["assignment"], "originalInput": originalInput, "original": original}
	return f
}
