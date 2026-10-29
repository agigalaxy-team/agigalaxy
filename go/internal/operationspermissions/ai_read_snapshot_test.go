package operationspermissions_test

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/jackc/pgx/v5"
)

// Count calls while retaining the real gateway's identity and permission checks.
type countedReadHuman struct {
	perms.Authority
	require, effective int
}

func (a *countedReadHuman) RequireWithin(ctx context.Context, tx pgx.Tx, actor perms.Actor, action string) (perms.Actor, error) {
	a.require++
	return a.Authority.RequireWithin(ctx, tx, actor, action)
}
func (a *countedReadHuman) EffectiveWithin(ctx context.Context, tx pgx.Tx, actor perms.Actor) (perms.Actor, error) {
	a.effective++
	return a.Authority.EffectiveWithin(ctx, tx, actor)
}

type countedReadSnapshot struct {
	*countedReadHuman
	gateway   *access.Gateway
	snapshots int
}

func (a *countedReadSnapshot) ReadHumanSnapshotWithin(ctx context.Context, tx pgx.Tx, actor perms.Actor) (perms.Actor, error) {
	a.snapshots++
	return a.gateway.ReadHumanSnapshotWithin(ctx, tx, actor)
}

type countedReadPerson struct {
	perms.StoredPersonAuthority
	reads int
}

func (a *countedReadPerson) PersonWithin(ctx context.Context, tx pgx.Tx, id string, eligibility bool) (perms.Actor, error) {
	a.reads++
	return a.StoredPersonAuthority.PersonWithin(ctx, tx, id, eligibility)
}

// Observe the real AI account and assignment reads without replacing PG.
type countedAIReadTx struct {
	pgx.Tx
	accounts, assignments int
}

func (tx *countedAIReadTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "FROM operations_ai_work_accounts_v1") {
		tx.accounts++
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}
func (tx *countedAIReadTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "FROM operations_ai_work_assignments_v1") {
		tx.assignments++
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func TestHumanAIReadSnapshotProjectionAndBarriers(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	fixture := operationsfixture.New(t, owner)
	accounts := object(fixture.Automation(t)["accounts"])
	ctx := context.Background()
	realTx, err := fixture.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer realTx.Rollback(ctx)
	tx := &countedAIReadTx{Tx: realTx}
	human := &countedReadHuman{Authority: fixture.Gateway}
	snapshot := &countedReadSnapshot{countedReadHuman: human, gateway: fixture.Gateway}
	service := fixture.Permissions
	service.Authority = snapshot

	current, err := service.HumanAIAccountReadWithin(ctx, tx, fixture.Root, "governance", text(accounts["governance"]), "query", "feedback.read")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.snapshots != 1 || human.require != 0 || human.effective != 0 || tx.accounts != 1 || tx.assignments != 1 {
		t.Fatalf("snapshot=%d require=%d effective=%d AI account=%d assignments=%d", snapshot.snapshots, human.require, human.effective, tx.accounts, tx.assignments)
	}

	// Unknown Authority implementations retain both RequireWithin checks and
	// the separate EffectiveWithin check instead of trusting a local snapshot.
	service.Authority = human
	human.require, human.effective, tx.accounts, tx.assignments = 0, 0, 0, 0
	fallback, err := service.HumanAIAccountReadWithin(ctx, tx, fixture.Root, "governance", text(accounts["governance"]), "query", "feedback.read")
	if err != nil {
		t.Fatal(err)
	}
	if human.require != 2 || human.effective != 1 || tx.accounts != 2 || tx.assignments != 2 {
		t.Fatalf("fallback require=%d effective=%d AI account=%d assignments=%d", human.require, human.effective, tx.accounts, tx.assignments)
	}
	if current.Version != fallback.Version || !reflect.DeepEqual(current.Permissions, fallback.Permissions) {
		t.Fatal("read snapshot changed the current human and AI intersection")
	}

	service.Authority = snapshot
	stored := &countedReadPerson{StoredPersonAuthority: fixture.Gateway}
	service.StoredAuthority = stored
	tx.accounts, tx.assignments = 0, 0
	storedActor, err := service.StoredHumanAIReadWithin(ctx, tx, fixture.Root.ID, "governance", text(accounts["governance"]), "query", "feedback.read")
	if err != nil {
		t.Fatal(err)
	}
	if stored.reads != 1 || tx.accounts != 1 || tx.assignments != 1 || storedActor.Version != current.Version {
		t.Fatalf("stored person=%d AI account=%d assignments=%d or projection mismatch", stored.reads, tx.accounts, tx.assignments)
	}
	if _, err = service.HumanAIAccountReadWithin(ctx, tx, current, "governance", text(accounts["overview"]), "query", "feedback.read"); fault.Code(err) != "operations_agentos_ai_use_denied" {
		t.Fatalf("changed fixed AI account accepted: %v", err)
	}
	if _, err = service.HumanAIAccountReadWithin(ctx, tx, fixture.Root, "governance", text(accounts["overview"]), "query", "feedback.read"); fault.Code(err) != "operations_ai_work_not_initialized" {
		t.Fatalf("unbound fixed AI account accepted: %v", err)
	}
	if _, err = service.HumanAIReadWithin(ctx, tx, fixture.Root, "governance", "query", "cases.read"); fault.Code(err) != "operations_permission_denied" {
		t.Fatalf("AI read permission was not enforced: %v", err)
	}
	if _, err = service.HumanAIReadWithin(ctx, tx, fixture.Root, "governance", "execution", "feedback.read"); fault.Code(err) != "operations_agentos_scope_denied" {
		t.Fatalf("execution purpose accepted by read interface: %v", err)
	}
	if _, err = service.HumanAIReadWithin(ctx, tx, fixture.Root, "governance", "prepare", "feedback.update"); fault.Code(err) != "operations_agentos_scope_denied" {
		t.Fatalf("write action accepted by read interface: %v", err)
	}

	snapshot.snapshots, human.require, human.effective = 0, 0, 0
	if _, err = service.HumanAIWithin(ctx, tx, fixture.Root, "governance", "prepare", "feedback.update"); err != nil {
		t.Fatal(err)
	}
	if snapshot.snapshots != 0 || human.require != 2 || human.effective != 1 {
		t.Fatalf("write-path checks changed: snapshot=%d require=%d effective=%d", snapshot.snapshots, human.require, human.effective)
	}
}
