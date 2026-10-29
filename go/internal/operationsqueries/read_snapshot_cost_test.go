package operationsqueries

import (
	"context"
	"reflect"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/jackc/pgx/v5"
)

type countedStoredReader struct {
	operationspermissions.StoredPersonAuthority
	reads int
}

func (s *countedStoredReader) PersonWithin(ctx context.Context, tx pgx.Tx, id string, eligibility bool) (operationspermissions.Actor, error) {
	s.reads++
	return s.StoredPersonAuthority.PersonWithin(ctx, tx, id, eligibility)
}

func TestReadHumanSnapshotAndSummaryRevocationBarrier(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	accounts := object(f.Automation(t)["accounts"])
	seedQueryRole(t, f, "governance", []any{"files.read"})
	ctx := context.Background()
	original := f.Gateway.StoredOperators()
	f.Permissions.StoredAuthority = original
	actor, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return f.Permissions.StoredHumanAIWithin(ctx, tx, f.Root.ID, "governance", str(accounts["governance"]), "query", "feedback.read")
	})
	if err != nil {
		t.Fatal(err)
	}
	stored := &countedStoredReader{StoredPersonAuthority: original}
	f.Permissions.StoredAuthority = stored
	queries := &Service{Pool: f.Pool, Permissions: f.Permissions, Now: f.Now}
	fresh, err := queries.human(ctx, actor, "governance", "feedback.read")
	if err != nil {
		t.Fatal(err)
	}
	if stored.reads != 1 {
		t.Fatalf("human query took %d stored person reads", stored.reads)
	}
	if fresh.Version != actor.Version || !reflect.DeepEqual(fresh.Permissions, actor.Permissions) {
		t.Fatal("snapshot changed current human and fixed-AI projection")
	}
	f.Permissions.StoredAuthority = original
	domain := &businessadmin.Domain{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: f.Now}
	invoked := false
	queries.Workbench = &Workbench{Domain: domain, FileSummaryWithin: func(ctx context.Context, tx pgx.Tx) (Object, error) {
		invoked = true
		_, err := owner.Exec(ctx, "UPDATE operations_ai_work_accounts_v1 SET enabled=false WHERE endpoint=$1 AND domain='governance'", f.Endpoint)
		return Object{}, err
	}}
	if _, err = queries.WorkbenchSummary(ctx, actor); fault.Code(err) != "operations_ai_work_disabled" || !invoked {
		t.Fatalf("final summary barrier failed to observe fixed-AI revocation: called=%v error=%v", invoked, err)
	}
}
