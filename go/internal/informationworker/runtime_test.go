package informationworker

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestExplicitDualRoleRuntimeRealProducerRiverAndOriginalWatchKey(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	path := filepath.Join(t.TempDir(), "information-fixture.json")
	node := exec.CommandContext(ctx, "node", filepath.Join(root, "go/internal/information/testdata/interop.mjs"), "setup", path)
	node.Dir = root
	node.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	var output bytes.Buffer
	node.Stdout = &output
	node.Stderr = &output
	if e := node.Run(); e != nil {
		t.Fatal(e, output.String())
	}
	data, _ := os.ReadFile(path)
	var f struct {
		Endpoint string
		Clock    int64
		Owner    struct{ Subject, Token string }
		Simple   map[string]any
	}
	if e := json.Unmarshal(data, &f); e != nil {
		t.Fatal(e)
	}
	pool := func(role string) *pgxpool.Pool {
		c := owner.Config()
		c.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error { _, e := conn.Exec(ctx, "SET ROLE "+role); return e }
		p, e := pgxpool.NewWithConfig(ctx, c)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(p.Close)
		return p
	}
	api, transport := pool("galaxy_api"), pool("galaxy_evidence_worker")
	tx, e := owner.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, owner, tx); e != nil {
		t.Fatal(e)
	}
	if e = jobs.ProvisionRolesWithin(ctx, tx); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	var logical atomic.Int64
	logical.Store(f.Clock)
	now := func() time.Time { return time.Unix(logical.Load(), 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: f.Endpoint, Now: now}
	cs := &cases.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	configuration := &configurations.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	cs.ConfigurationCondition = configuration.ConditionWithin
	tasks := &taskmaterials.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	history := &historyv2.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Profiles: &profiles.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}, Tasks: tasks.ReadHistoryWireWithin, Now: now}
	search := &searchv2.Service{Pool: api, Devices: devices, History: history, Now: now}
	info := &information.Service{Endpoint: f.Endpoint, Search: search, Now: now}
	var paused atomic.Bool
	paused.Store(true)
	watches := &information.Watches{Pool: api, Devices: devices, Information: info, Now: now, CanProcessBackground: func() bool { return !paused.Load() }}
	config := Config{SourcePool: api, TransportPool: transport, Endpoint: f.Endpoint, Watches: watches}
	if _, e = New(ctx, Config{}); fault.Code(e) != "information_worker_configuration_unavailable" {
		t.Fatal("missing explicit connections", e)
	}
	wrong := config
	wrong.TransportPool = pool("galaxy_api")
	if _, e = New(ctx, wrong); fault.Code(e) != "information_worker_role_boundary_mismatch" {
		t.Fatal("API role accepted as River worker", e)
	}
	r, e := New(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	if watches.Tasks != nil || watches.HasOutstanding != nil {
		t.Fatal("runtime mutated root API service")
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM galaxy_river.river_job`).Scan(&count); e != nil || count != 0 {
		t.Fatal("constructor started/enqueued work", count, e)
	}
	if _, e = transport.Exec(ctx, `UPDATE information_watches_v2 SET background_state=background_state WHERE false`); e == nil {
		t.Fatal("transport role acquired API mutation authority")
	}
	if _, e = owner.Exec(ctx, `INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend)VALUES($1,'river')`, f.Endpoint); e != nil {
		t.Fatal(e)
	}
	actor, e := devices.Authenticate(ctx, f.Owner.Token, "notifications")
	if e != nil {
		t.Fatal(e)
	}
	apiWatches := *watches
	apiWatches.Tasks = func(ctx context.Context, tx pgx.Tx, key string, payload map[string]any, at time.Time) error {
		if e := r.EnqueueWithin(ctx, tx, key, payload, at); e != nil {
			return e
		}
		return fault.New("controlled_producer_rollback", 503)
	}
	rollback := map[string]any{}
	for k, v := range f.Simple {
		rollback[k] = v
	}
	rollback["operationId"] = uuid.NewString()
	rollback["watchId"] = uuid.NewString()
	raw, _ := protocol.EncodeJS(rollback)
	if _, e = apiWatches.Command(ctx, actor, raw, ""); fault.Code(e) != "controlled_producer_rollback" {
		t.Fatal(e)
	}
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM information_watches_v2 WHERE id=$1`, rollback["watchId"]).Scan(&count); e != nil || count != 0 {
		t.Fatal("watch rollback", count, e)
	}
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM galaxy_river.river_job`).Scan(&count); e != nil || count != 0 {
		t.Fatal("River rollback", count, e)
	}
	apiWatches.Tasks = r.EnqueueWithin
	apiWatches.HasOutstanding = r.HasOutstandingWithin
	raw, _ = protocol.EncodeJS(f.Simple)
	created, e := apiWatches.Command(ctx, actor, raw, "")
	if e != nil {
		t.Fatal(e)
	}
	watchID := f.Simple["watchId"].(string)
	slot := func() (string, int64) {
		t.Helper()
		var id string
		var riverID int64
		if e := owner.QueryRow(ctx, `SELECT s.execution_id::text,e.river_id FROM galaxy_go_jobs.singleton_slots_v1 s JOIN galaxy_go_jobs.executions_v1 e ON e.id=s.execution_id WHERE s.endpoint=$1 AND s.action='information-watch' AND s.slot_key=$2`, f.Endpoint, "watch:"+watchID+":1:0").Scan(&id, &riverID); e != nil {
			t.Fatal(e)
		}
		return id, riverID
	}
	first, riverID := slot()
	// Map only the disposable transport's availability to wall time; original
	// Watch deadlines/check revisions and the source logical clock stay intact.
	if _, e = owner.Exec(ctx, `UPDATE galaxy_river.river_job SET scheduled_at=now() WHERE id=$1`, riverID); e != nil {
		t.Fatal(e)
	}
	if e = r.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer func() {
		stop, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if e := r.Stop(stop); e != nil {
			t.Error(e)
		}
	}()
	wait := func(id, state string) {
		t.Helper()
		until := time.Now().Add(15 * time.Second)
		for time.Now().Before(until) {
			var got, status string
			e := owner.QueryRow(ctx, `SELECT e.state,e.result->>'state' FROM galaxy_go_jobs.executions_v1 e JOIN galaxy_river.river_job j ON j.id=e.river_id WHERE e.id=$1 AND j.state='completed'`, id).Scan(&got, &status)
			if e == nil && got == "succeeded" && status == state {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("runtime did not finish original job %s as %s", id, state)
	}
	wait(first, "service-paused")
	logical.Add(61)
	paused.Store(false)
	if result, e := r.Reconcile(ctx); e != nil || result["queued"] != 1 {
		t.Fatal("same business key reconciliation", result, e)
	}
	second, riverID := slot()
	if second == first {
		t.Fatal("completed transport permanently suppressed watch key")
	}
	if _, e = owner.Exec(ctx, `UPDATE galaxy_river.river_job SET scheduled_at=now() WHERE id=$1`, riverID); e != nil {
		t.Fatal(e)
	}
	wait(second, "unchanged")
	var revision, checkRevision int
	if e = owner.QueryRow(ctx, `SELECT revision,check_revision FROM information_watches_v2 WHERE id=$1`, watchID).Scan(&revision, &checkRevision); e != nil || revision != 1 || checkRevision != 1 {
		t.Fatal("business identity changed", revision, checkRevision, e)
	}
	receiptRaw, _ := protocol.EncodeJS(map[string]any{"operationId": f.Simple["operationId"], "requestHash": created["requestHash"]})
	if receipt, e := apiWatches.Receipt(ctx, actor, receiptRaw); e != nil || receipt["state"] != "acknowledged" {
		t.Fatal("original producer receipt", receipt, e)
	}
	if e = r.Stop(ctx); e != nil {
		t.Fatal(e)
	}
	if result, e := r.Reconcile(ctx); e != nil || result["queued"] != 0 {
		t.Fatal("stopped runtime continued reconciling", result, e)
	}
}
