package resourcebudget

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type tracedTx struct {
	pgx.Tx
	events *[]string
}

func (t tracedTx) Exec(ctx context.Context, q string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(q, "pg_advisory_xact_lock(734912309") {
		*t.events = append(*t.events, "lock")
	}
	return t.Tx.Exec(ctx, q, args...)
}
func (t tracedTx) QueryRow(ctx context.Context, q string, args ...any) pgx.Row {
	for i, sql := range []string{subjectPayloadSQL, subjectJobsSQL, subjectExportsSQL} {
		if q == sql {
			*t.events = append(*t.events, []string{"bytes", "jobs", "exports"}[i])
		}
	}
	return t.Tx.QueryRow(ctx, q, args...)
}
func TestResourceWriteActualSQLLockOrderAndRollback(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	var subject string
	node := func(mode string) []byte {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/resource-budget-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_BUDGET_SUBJECT="+subject)
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original JS %s: %v %s", mode, e, out)
		}
		return out
	}
	var fixture struct{ SubjectID, BindingID, CredentialHash, AccountID, ScopeID, PublicKeyPEM string }
	if e := json.Unmarshal(node("setup"), &fixture); e != nil {
		t.Fatal(e)
	}
	subject = fixture.SubjectID
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := int64(2000000000)
	usage, e := SubjectResourceUsage(ctx, pool, subject, now)
	if e != nil {
		t.Fatal(e)
	}
	var original oracleUsage
	if e = json.Unmarshal(node("usage"), &original); e != nil || usage.PayloadBytes.Cmp(original.native().PayloadBytes) != 0 || usage.QueuedJobs != original.QueuedJobs || usage.ActiveExports != original.ActiveExports || usage.QueuedJobs != 2 || usage.ActiveExports != 1 {
		t.Fatalf("Go/JS usage differs: %+v %+v %v", usage, original, e)
	}
	// The additional public audit fields come from the fresh row, not Actor cache.
	authService := &deviceauth.Service{Pool: pool, Endpoint: "https://budget.example.invalid", Now: func() time.Time { return time.Unix(now, 0) }}
	device := deviceauth.Actor{SubjectID: subject, BindingID: fixture.BindingID, CredentialHash: fixture.CredentialHash, Scopes: []string{"stale"}, Authentication: deviceauth.Authentication{CredentialScopes: []string{"stale"}}}
	fresh, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (deviceauth.ControlAuthorization, error) {
		return authService.CurrentControlWithin(ctx, tx, device, "binding")
	})
	if e != nil || !reflect.DeepEqual(fresh.CredentialScopes, []string{"binding"}) || !reflect.DeepEqual(fresh.BindingScopes, []string{"binding", "consent"}) {
		t.Fatalf("fresh audit scopes mismatch: %+v %v", fresh, e)
	}
	lockTx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = LockSubjectResourceBudget(ctx, lockTx, subject); e != nil {
		t.Fatal(e)
	}
	var lockResult struct{ Blocked, Locked bool }
	if e = json.Unmarshal(node("original-lock"), &lockResult); e != nil || !lockResult.Blocked {
		t.Fatal("original JS resource lock did not contend with Go")
	}
	if e = lockTx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	lockResult.Blocked = false
	if e = json.Unmarshal(node("original-lock"), &lockResult); e != nil || !lockResult.Locked {
		t.Fatal("resource lock not released by transaction")
	}
	policy := DefaultPolicy()
	policy.MaxPayloadBytesPerSubject = usage.PayloadBytes.Int64()
	budget, e := New(&policy, func() time.Time { return time.Unix(now, 0) })
	if e != nil {
		t.Fatal(e)
	}
	events := []string{}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (any, error) {
		trace := tracedTx{tx, &events}
		return budget.ResourceWrite(ctx, trace, Actor{subject}, func(context.Context, pgx.Tx) error { events = append(events, "authorize"); return nil }, func(ctx context.Context, tx pgx.Tx) (any, error) {
			events = append(events, "operation")
			_, e := tx.Exec(ctx, "UPDATE account_work_v1 SET data=$2 WHERE account_id=$1", fixture.AccountID, map[string]any{"title": strings.Repeat("新增字节", 200)})
			return "write", e
		}, Options{})
	})
	if fault.Code(e) != "storage_quota_exceeded" {
		t.Fatalf("over-budget storage write: %v", e)
	}
	want := []string{"lock", "authorize", "bytes", "jobs", "exports", "operation", "bytes", "jobs", "exports"}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("resource write order=%v", events)
	}
	after, e := SubjectResourceUsage(ctx, pool, subject, now)
	if e != nil || after.PayloadBytes.Cmp(usage.PayloadBytes) != 0 {
		t.Fatal("quota failure did not roll back original write")
	}
	// Already-over-budget resources can remain stable or shrink.
	zero := policy
	zero.MaxPayloadBytesPerSubject = 0
	over, e := New(&zero, func() time.Time { return time.Unix(now, 0) })
	if e != nil {
		t.Fatal(e)
	}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (any, error) {
		return over.ResourceWrite(ctx, tx, Actor{subject}, func(context.Context, pgx.Tx) error { return nil }, func(context.Context, pgx.Tx) (any, error) { return "original receipt", nil }, Options{})
	})
	if e != nil {
		t.Fatalf("unchanged over-budget operation denied: %v", e)
	}
	// Control retains serialization and authority, but does not run accounting.
	events = nil
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (any, error) {
		return over.ResourceWrite(ctx, tracedTx{tx, &events}, Actor{subject}, func(context.Context, pgx.Tx) error { events = append(events, "authorize"); return nil }, func(context.Context, pgx.Tx) (any, error) { events = append(events, "operation"); return nil, nil }, Options{Control: true})
	})
	if e != nil || !reflect.DeepEqual(events, []string{"lock", "authorize", "operation"}) {
		t.Fatalf("control semantics %v %v", events, e)
	}
	disabled, _ := New(nil, nil)
	events = nil
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (any, error) {
		return disabled.ResourceWrite(ctx, tracedTx{tx, &events}, Actor{subject}, func(context.Context, pgx.Tx) error { events = append(events, "authorize"); return nil }, func(context.Context, pgx.Tx) (any, error) { events = append(events, "operation"); return nil, nil }, Options{})
	})
	if e != nil || !reflect.DeepEqual(events, []string{"authorize", "operation"}) {
		t.Fatal("unconfigured policy acquired quota authority")
	}
	denied := errors.New("original authorization denied")
	events = nil
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (any, error) {
		return budget.ResourceWrite(ctx, tracedTx{tx, &events}, Actor{subject}, func(context.Context, pgx.Tx) error { events = append(events, "authorize"); return denied }, func(context.Context, pgx.Tx) (any, error) { t.Error("denied operation ran"); return nil, nil }, Options{})
	})
	if !errors.Is(e, denied) || !reflect.DeepEqual(events, []string{"lock", "authorize"}) {
		t.Fatal("usage read or operation preceded failed authorization")
	}
	// Actual shared subject lock serializes two contenders for one remaining job.
	queuePolicy := DefaultPolicy()
	queuePolicy.MaxQueuedJobsPerSubject = 3
	queue, _ := New(&queuePolicy, func() time.Time { return time.Unix(now, 0) })
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			<-start
			_, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (any, error) {
				return queue.ResourceWrite(ctx, tx, Actor{subject}, func(context.Context, pgx.Tx) error { return nil }, func(ctx context.Context, tx pgx.Tx) (any, error) {
					_, e := tx.Exec(ctx, "INSERT INTO jobs(id,kind,deduplication_key,payload) VALUES($1,'builder-probe',$2,$3)", uuid.NewString(), uuid.NewString(), map[string]any{"subjectId": subject})
					return nil, e
				}, Options{})
			})
			results <- e
		})
	}
	close(start)
	wg.Wait()
	close(results)
	accepted, rejected := 0, 0
	for e := range results {
		if e == nil {
			accepted++
		} else if fault.Code(e) == "job_queue_quota_exceeded" {
			rejected++
		} else {
			t.Fatal(e)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("quota contenders accepted=%d rejected=%d", accepted, rejected)
	}
	exportPolicy := DefaultPolicy()
	exportPolicy.MaxActiveExportsPerSubject = 1
	exportBudget, _ := New(&exportPolicy, func() time.Time { return time.Unix(now, 0) })
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (any, error) {
		return exportBudget.ResourceWrite(ctx, tx, Actor{subject}, func(context.Context, pgx.Tx) error { return nil }, func(ctx context.Context, tx pgx.Tx) (any, error) {
			_, e := tx.Exec(ctx, "INSERT INTO data_exports(id,subject_id,binding_id,datasets,bounds,selection_cutoff,expires_at) VALUES($1,$2,$3,'[]','{}',$4,$5)", uuid.NewString(), subject, fixture.BindingID, time.Unix(now, 0), time.Unix(now+600, 0))
			return nil, e
		}, Options{})
	})
	if fault.Code(e) != "export_ticket_quota_exceeded" {
		t.Fatalf("export growth %v", e)
	}
	current, e := SubjectResourceUsage(ctx, pool, subject, now)
	if e != nil || current.ActiveExports != 1 || current.QueuedJobs != 3 || current.PayloadBytes.Cmp(new(big.Int).Set(usage.PayloadBytes)) != 0 {
		t.Fatalf("final retained counters: %+v %v", current, e)
	}
}
