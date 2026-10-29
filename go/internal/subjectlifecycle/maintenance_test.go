package subjectlifecycle

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestOriginalMaintenanceInventoryAndSignedApprovalPreparation(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	dir := t.TempDir()
	prepared := deviceauthfixture.New(t, pool, dir, []string{"binding", "data-export", "data-delete"})
	if _, e := databaseschema.Migrate(ctx, pool, []string{"deletion-review"}); e != nil {
		t.Fatal(e)
	}
	svc := &Service{Pool: pool, Endpoint: prepared.Service.Endpoint, Devices: prepared.Service, Now: func() time.Time { return time.Unix(2000000000, 0) }}
	requestID, approvalID := uuid.NewString(), uuid.NewString()
	intent := map[string]any{"version": 1, "id": requestID, "endpoint": prepared.Service.Endpoint, "subjectId": prepared.Actor.SubjectID, "bindingId": prepared.Actor.BindingID, "issuedAt": int64(2000000000), "expiresAt": int64(2000000300), "action": "request", "scope": "all-owned-service-data", "reason": "privacy", "takeout": "not-needed"}
	intentRaw, e := protocol.EncodeJS(intent)
	if e != nil {
		t.Fatal(e)
	}
	private, e := identity.PrivatePEM([]byte(prepared.Materials.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	signed, e := identity.SignIdentityPayload(private, string(intentRaw), "galaxy-deletion-intent+jws")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = svc.SubmitDeletion(ctx, Actor{Actor: prepared.Actor}, signed); e != nil {
		t.Fatal(e)
	}
	plan := &DeletionPlan{PolicyID: "fixture-policy", PolicyVersion: "1", ExternalCopies: "outside-service-control"}
	plan.Primary.Action, plan.Primary.NotBefore, plan.Primary.Basis = "delete-owned-data", 2000000000, "fixture"
	plan.Audit.Action, plan.Audit.Until, plan.Audit.Basis = "retain-minimum", 2000000100, "fixture"
	plan.Backups.Action, plan.Backups.Until, plan.Backups.Basis = "expire-snapshots-and-replay-deletions", 2000000200, "fixture"
	approval := ReviewCommand{Version: 1, ID: approvalID, RequestID: requestID, Endpoint: prepared.Service.Endpoint, ExpectedRevision: 1, ReviewerRef: "isolated-reviewer", Decision: "approve", Explanation: "isolated fixture only", Plan: plan}
	approvalRaw, e := protocol.EncodeJS(approval)
	if e != nil {
		t.Fatal(e)
	}
	reviewer, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_deletion_reviewer")
	if e != nil {
		t.Fatal(e)
	}
	defer reviewer.Close()
	if _, e = postgres.InTx(ctx, reviewer, func(tx pgx.Tx) (Object, error) { return ReviewDeletionWithin(ctx, tx, approvalRaw) }); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `UPDATE access_credentials SET scopes='["data-export"]'::jsonb WHERE token_hash=$1`, identity.Digest([]byte(prepared.Credential))); e != nil {
		t.Fatal(e)
	}
	var fixture struct {
		Command  ExecutionCommand
		Original struct {
			Keys        map[string][]Object
			Constraints int
		}
		Targets map[string]string
	}
	raw, e := os.ReadFile("testdata/original-maintenance-catalog.json")
	if e != nil {
		t.Fatal(e)
	}
	if e := json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e)
	}
	fixture.Command = ExecutionCommand{Version: 1, ID: uuid.NewString(), RequestID: requestID, ApprovalID: approvalID, Endpoint: prepared.Service.Endpoint, ExpectedRevision: 2, ExecutorRef: "isolated-executor"}
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
	devices := prepared.Service
	token := []byte(prepared.Credential)
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
