package subjectlifecycle

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestOriginalMaintenanceInventoryAndSignedApprovalPreparation(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	for _, mode := range []string{"setup", "maintenance", "limited"} {
		cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/subject-lifecycle-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir, "GALAXY_GO_TEST_DEVICE_ORIGIN=http://127.0.0.1")
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("original maintenance %s: %v %s", mode, e, out)
		}
	}
	var fixture struct {
		Command  ExecutionCommand
		Original struct {
			Keys        map[string][]Object
			Constraints int
		}
		Targets map[string]string
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "maintenance.json"))
	if e := json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e)
	}
	if len(fixture.Targets) != len(maintenanceCatalog.Targets) {
		t.Fatal("original deletion target catalog changed")
	}
	for name, where := range fixture.Targets {
		if maintenanceCatalog.Targets[name] != where {
			t.Fatal("original deletion predicate changed", name)
		}
	}
	p, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (ExecutionPreparation, error) {
		return PrepareExecutionWithin(ctx, tx, fixture.Command, 2000000000)
	})
	if e != nil {
		t.Fatal(e)
	}
	if p.SubjectID == "" || p.Plan.Audit.Until != 2000000100 || p.PriorResult != nil || len(p.Inventory.References) != fixture.Original.Constraints || len(p.Inventory.Keys) != len(fixture.Original.Keys) {
		t.Fatal("original maintenance preparation mismatch")
	}
	for table, keys := range fixture.Original.Keys {
		actual := p.Inventory.Keys[table]
		if len(actual) != len(keys) {
			t.Fatal("original primary keys differ", table)
		}
		for i, key := range keys {
			if actual[i].Column != text(key["column"]) || actual[i].Type != text(key["type"]) || actual[i].Order != integer(key["ord"]) {
				t.Fatal("original primary key differs", table)
			}
		}
	}
	// A real original credential containing only data-export must reach the
	// lifecycle reader without silently borrowing the normal binding scope.
	devices, e := deviceauth.Load(ctx, pool, deviceauth.Configuration{Endpoint: "https://device.example.invalid", SigningKeyID: "fixture", SigningKeyFile: filepath.Join(dir, "hub-private.pem"), RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(2000000000, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	token, _ := os.ReadFile(filepath.Join(dir, "limited-credential.txt"))
	actor, e := devices.Authenticate(ctx, string(token), "data-export")
	if e != nil {
		t.Fatal(e)
	}
	forum := &community.Service{Pool: pool, Endpoint: devices.Endpoint, DeviceAuth: devices, Now: func() time.Time { return time.Unix(2000000000, 0) }}
	post, version := uuid.NewString(), uuid.NewString()
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return forum.ReadLifecycleVersionWithin(ctx, tx, actor, post, version)
	})
	if fault.Status(e) != 404 {
		t.Fatal("data-export-only credential did not reach original version reader", e)
	}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return forum.ReadVersionWithin(ctx, tx, "", nil, &actor, post, version)
	})
	if fault.Status(e) != 401 {
		t.Fatal("normal binding reader scope changed", e)
	}
	// The preparation has not changed source data, request state or execution
	// progress, and an unclassified public table stops the next maintenance run.
	var state string
	var count int
	if e = pool.QueryRow(ctx, "SELECT state FROM deletion_requests WHERE id=$1", fixture.Command.RequestID).Scan(&state); e != nil || state != "approved" {
		t.Fatal(state, e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM deletion_executions").Scan(&count); e != nil || count != 0 {
		t.Fatal("preparation wrote execution receipt", e)
	}
	if _, e = pool.Exec(ctx, "CREATE TABLE lifecycle_unknown_fixture(id integer PRIMARY KEY)"); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (DeletionInventory, error) { return LockDeletionTablesWithin(ctx, tx) }); e == nil {
		t.Fatal("unclassified public table accepted")
	}
}
