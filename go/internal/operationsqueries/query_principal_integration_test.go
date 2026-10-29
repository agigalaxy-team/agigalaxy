package operationsqueries

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestStoredHumanAIQueryPrincipalFeedbackAndSummary(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	accounts := object(f.Automation(t)["accounts"])
	ctx := context.Background()
	f.Permissions.StoredAuthority = f.Gateway.StoredOperators()
	actor, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return f.Permissions.StoredHumanAIWithin(ctx, tx, f.Root.ID, "governance", str(accounts["governance"]), "query", "feedback.read")
	})
	if err != nil {
		t.Fatal(err)
	}
	domain := &businessadmin.Domain{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: f.Now}
	source := &feedback.Operations{Service: &feedback.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now}, Domain: domain}
	queries := &Service{Pool: f.Pool, Permissions: f.Permissions, Feedback: source, Workbench: &Workbench{Domain: domain}, Now: f.Now}
	result, err := queries.Query(ctx, actor, "governance", "query-operations", Object{"module": "feedback", "view": "list"})
	if err != nil || result["availability"] != "available" {
		t.Fatalf("stored AI feedback read: %v %#v", err, result)
	}
	if _, err = queries.WorkbenchSummary(ctx, actor); err != nil {
		t.Fatalf("stored AI summary: %v", err)
	}

	// The same principal read mechanism works through both the direct query
	// authority and the BusinessAuthority used by owning action facades.
	reader := f.Permissions.QueryReader()
	for _, authority := range []operationspermissions.Authority{reader, &operationspermissions.BusinessAuthority{Human: reader}} {
		readDomain := *domain
		readDomain.Authority = authority
		tx, err := f.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		principal, err := readDomain.ReadPrincipal(ctx, tx, actor, f.Gateway.ReadOperationsPrincipalWithin)
		if err != nil || principal["issuer"] != f.Issuer || principal["externalSubject"] != "root" {
			t.Fatalf("current principal: %v %#v", err, principal)
		}
		if err = readDomain.Principal(ctx, tx, actor); err != nil {
			t.Fatalf("current principal lock: %v", err)
		}
		other, err := owner.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = other.Exec(ctx, "SET LOCAL lock_timeout='100ms'"); err != nil {
			t.Fatal(err)
		}
		_, lockErr := other.Exec(ctx, "UPDATE operations_operator_principals_v1 SET display_name=display_name WHERE endpoint=$1 AND operator_id=$2", f.Endpoint, f.Root.ID)
		var pgErr *pgconn.PgError
		if !errors.As(lockErr, &pgErr) || pgErr.Code != "55P03" {
			t.Fatalf("principal row was not pinned: %v", lockErr)
		}
		other.Rollback(ctx)
		tx.Rollback(ctx)
		called := false
		readDomain.Permissions = func(string, Object) []string { return []string{"workbench.read"} }
		if _, err = readDomain.Command(ctx, actor, "synthetic-write", Object{}, func(pgx.Tx, operationspermissions.Actor) (Object, error) { called = true; return Object{}, nil }); fault.Code(err) != "operations_agentos_scope_denied" || called {
			t.Fatalf("query authority reached command: %v", err)
		}
	}
	forged := actor
	forged.ID = f.IDs["writer"]
	readDomain := *domain
	readDomain.Authority = reader
	tx, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = readDomain.Principal(ctx, tx, forged); err == nil {
		t.Fatal("forged person accepted")
	}
	tx.Rollback(ctx)
	tx, err = f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reader.RequireWithin(ctx, tx, actor, "feedback.update"); fault.Code(err) != "operations_permission_denied" {
		t.Fatalf("query proof allowed feedback write authority: %v", err)
	}
	tx.Rollback(ctx)

	if _, err = owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='governance'", f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = queries.Query(ctx, actor, "governance", "query-operations", Object{"module": "feedback", "view": "list"}); fault.Code(err) != "operations_ai_work_disabled" {
		t.Fatalf("disabled fixed AI remained readable: %v", err)
	}
}

// A durable AI preparation reads a real feedback row under its original human
// and fixed-AI proof. Executing a confirmed card still uses a fresh portal
// human proof and the normal feedback update authority.
func TestStoredPreparationReadAndConfirmedHumanFeedback(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	accounts := object(f.Automation(t)["accounts"])
	ctx := context.Background()
	f.Permissions.StoredAuthority = f.Gateway.StoredOperators()
	account := seedQueryAccount(t, f, "https://public.example.invalid/realms/public", "feedback-owner")
	feedbackID, operationID := uuid.NewString(), uuid.NewString()
	_, err := owner.Exec(ctx, `INSERT INTO operations_feedback_v1(id,endpoint,account_id,submission_operation_id,request_hash,title,body,submitted_module,module,state,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Synthetic feedback','Synthetic detail','other','other','pending',1,$6,$6)`, feedbackID, f.Endpoint, account.ID, operationID, strings.Repeat("a", 64), f.Now())
	if err != nil {
		t.Fatal(err)
	}
	domain := &businessadmin.Domain{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: f.Now}
	source := &feedback.Operations{Service: &feedback.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now}, Domain: domain}
	stored, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return f.Permissions.StoredHumanAIWithin(ctx, tx, f.Root.ID, "governance", str(accounts["governance"]), "prepare", "feedback.read")
	})
	if err != nil {
		t.Fatal(err)
	}
	prepare := f.Permissions.PreparationReader()
	for _, authority := range []operationspermissions.Authority{prepare, &operationspermissions.BusinessAuthority{Human: prepare}} {
		result, err := source.WithAuthority(authority).Get(ctx, stored, feedbackID, "")
		if err != nil || object(result["feedback"])["id"] != feedbackID {
			t.Fatalf("stored prepare feedback read: %v %#v", err, result)
		}
		readDomain := *domain
		readDomain.Authority = authority
		tx, err := f.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		principal, err := readDomain.ReadPrincipal(ctx, tx, stored, f.Gateway.ReadOperationsPrincipalWithin)
		if err != nil || principal["issuer"] != f.Issuer || principal["externalSubject"] != "root" {
			t.Fatalf("stored prepare principal: %v %#v", err, principal)
		}
		tx.Rollback(ctx)
		called := false
		readDomain.Permissions = func(string, Object) []string { return []string{"workbench.read"} }
		_, err = readDomain.Command(ctx, stored, "synthetic-write", Object{}, func(pgx.Tx, operationspermissions.Actor) (Object, error) {
			called = true
			return Object{}, nil
		})
		if fault.Code(err) != "operations_agentos_scope_denied" || called {
			t.Fatalf("stored prepare reached business command: %v", err)
		}
		attempt := []byte(fmt.Sprintf(`{"operationId":"%s","expectedRevision":1,"state":"processing"}`, uuid.NewString()))
		if _, err = source.WithAuthority(authority).Event(ctx, stored, feedbackID, attempt); fault.Code(err) != "operations_agentos_scope_denied" {
			t.Fatalf("stored prepare reached feedback update: %v", err)
		}
	}
	var revision int
	if err = owner.QueryRow(ctx, "SELECT revision FROM operations_feedback_v1 WHERE id=$1", feedbackID).Scan(&revision); err != nil || revision != 1 {
		t.Fatalf("preparation changed feedback: %v revision=%d", err, revision)
	}
	// Confirmed execution's authorize callback supplies this real fresh portal
	// actor; the preparation reader must keep the existing action permission.
	human, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "governance", "prepare", "feedback.update")
	})
	if err != nil {
		t.Fatal(err)
	}
	command := []byte(fmt.Sprintf(`{"operationId":"%s","expectedRevision":1,"state":"processing"}`, uuid.NewString()))
	updated, err := source.WithAuthority(&operationspermissions.BusinessAuthority{Human: prepare}).Event(ctx, human, feedbackID, command)
	if err != nil || object(updated["feedback"])["state"] != "processing" {
		t.Fatalf("confirmed human feedback update: %v %#v", err, updated)
	}
	if _, err = owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='governance'", f.Endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = source.WithAuthority(prepare).Get(ctx, stored, feedbackID, ""); fault.Code(err) != "operations_ai_work_disabled" {
		t.Fatalf("disabled fixed AI remained available to prepare: %v", err)
	}
}
