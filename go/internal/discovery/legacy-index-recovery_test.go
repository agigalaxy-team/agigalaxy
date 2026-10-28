package discovery

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyRecoveryCancelledManualRetrySameGeneration(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	var fixture Object
	if e := decode(originalNode(t, dsn, false, "setup"), &fixture); e != nil {
		t.Fatal(e)
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, pool, tx); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	var index *LegacyIndex
	var calls atomic.Int32
	q, e := jobs.NewWithQueues(pool, func(ctx context.Context, task jobs.Task) (jobs.Outcome, error) {
		calls.Add(1)
		return index.Work(ctx, task)
	}, map[string]int{jobs.SearchRecovery: 2})
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC().Truncate(time.Second)
	index = &LegacyIndex{Pool: pool, Endpoint: str(fixture, "endpoint"), Now: func() time.Time { return now }, Jobs: q}
	if _, e = index.Configure(ctx, true, false); e != nil {
		t.Fatal(e)
	}
	id, source := uuid.NewString(), uuid.NewString()
	payload := Object{"sourceType": "case", "sourceId": source, "subjectId": "GUID" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "generation": 7}
	if _, e = pool.Exec(ctx, `INSERT INTO jobs(id,kind,deduplication_key,payload,state,attempts,available_at) VALUES($1,'search-index',$2,$3,'failed',5,$4)`, id, "recovery-test:"+id, payload, now); e != nil {
		t.Fatal(e)
	}
	recover := func(want int) {
		t.Helper()
		v, e := index.RecoverFailed(ctx, 10)
		if e != nil || v["queued"] != want {
			t.Fatalf("recover %v %v, want %d", v, e, want)
		}
	}
	recover(1)
	read := func(id string) Object {
		t.Helper()
		r, e := rowObject(ctx, pool, `SELECT to_jsonb(e)||jsonb_build_object('args',q.args,'transport_state',q.state) FROM galaxy_go_jobs.executions_v1 e JOIN galaxy_river.river_job q ON q.id=e.river_id WHERE e.id=$1`, id)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	var firstID string
	if e = pool.QueryRow(ctx, "SELECT id::text FROM galaxy_go_jobs.executions_v1 WHERE source_id=$1", id).Scan(&firstID); e != nil {
		t.Fatal(e)
	}
	first := read(firstID)
	tx, _ = pool.Begin(ctx)
	if e = q.CancelWithin(ctx, tx, index.Endpoint, firstID); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	cancelled := read(firstID)
	recover(0) // A cancelled recovery remains blocked until current manual authority.
	if _, e = index.RetryFailed(ctx, id, 7, LegacyRetryOptions{}); e == nil {
		t.Fatal("missing current authority accepted")
	}
	var authorized int
	retry := LegacyRetryOptions{Authorize: func(context.Context, pgx.Tx) error { authorized++; return nil }}
	if _, e = index.RetryFailed(ctx, id, 7, retry); e != nil {
		t.Fatal(e)
	}
	superseded := read(firstID)
	if authorized != 1 || superseded["superseded_at"] == nil {
		t.Fatalf("manual retry not atomic %d %v", authorized, superseded)
	}
	for _, key := range []string{"state", "args", "request_hash", "result", "river_id", "transport_state"} {
		if !reflect.DeepEqual(cancelled[key], superseded[key]) {
			t.Fatalf("cancelled history changed %s", key)
		}
	}
	// Simulate the source's next bounded processing cycle failing again. The
	// generation and original business identity remain the same.
	if _, e = pool.Exec(ctx, "UPDATE jobs SET state='failed',attempts=5 WHERE id=$1", id); e != nil {
		t.Fatal(e)
	}
	recover(1)
	recover(0)
	var secondID string
	if e = pool.QueryRow(ctx, "SELECT id::text FROM galaxy_go_jobs.executions_v1 WHERE source_id=$1 AND superseded_at IS NULL", id).Scan(&secondID); e != nil {
		t.Fatal(e)
	}
	if secondID == firstID {
		t.Fatal("new transport reused cancelled UUID")
	}
	second := read(secondID)
	var task jobs.Task
	if e = json.Unmarshal([]byte(jsonString(second["args"])), &task); e != nil {
		t.Fatal(e)
	}
	if task.SourceID != id || task.Generation != 7 || task.RecoveryAttempt != 1 {
		t.Fatalf("source contract changed %+v", task)
	}
	if _, e = pool.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", index.Endpoint); e != nil {
		t.Fatal(e)
	}
	tx, _ = pool.Begin(ctx)
	if e = q.ResumeWithin(ctx, tx, index.Endpoint, secondID); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = q.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer q.Stop(context.Background())
	deadline := time.Now().Add(10 * time.Second)
	for {
		view, e := q.Get(ctx, index.Endpoint, secondID)
		if e != nil {
			t.Fatal(e)
		}
		if view.State == "succeeded" {
			if view.Result["state"] != "requeued" {
				t.Fatalf("actual River recovery %v", view)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("actual River recovery timed out %v", view)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("business consumer invoked %d times", calls.Load())
	}
	result, e := index.RecoverJob(ctx, task)
	if e != nil || result["state"] != "superseded" {
		t.Fatalf("replayed recovery %v %v", result, e)
	}
	if !reflect.DeepEqual(first["args"], read(firstID)["args"]) {
		t.Fatal("original payload overwritten")
	}
	var count int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM jobs WHERE id=$1 AND state='pending' AND attempts=0", id).Scan(&count); e != nil || count != 1 {
		t.Fatalf("source was duplicated %d %v", count, e)
	}
}

func TestLegacyIndexGenerationLeaseAndCancellation(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	var f Object
	if e := decode(originalNode(t, dsn, false, "setup"), &f); e != nil {
		t.Fatal(e)
	}
	// The fixture has the complete retained schema; install only the original
	// limited worker grants, without extending access for this consumer.
	root, _ := filepath.Abs("../../..")
	sql, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src/infrastructure/worker-role.sql"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, string(sql)); e != nil {
		t.Fatal(e)
	}
	cfg := pool.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	index := &LegacyIndex{Pool: worker, Endpoint: str(f, "endpoint"), Now: func() time.Time { return time.Now().Add(2 * time.Second) }}
	if _, e = index.Configure(ctx, true, false); e != nil {
		t.Fatal(e)
	}
	source := uuid.NewString()
	var identityFixture Object
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{serviceFixture}from './packages/galaxy-official/test/service-fixture.mjs';const db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{const f=await serviceFixture(['binding','consent'],db,{endpoint:process.argv[1],now:Math.floor(Date.now()/1000),migrateDatabase:false});console.log(JSON.stringify({subject:f.actor.subjectId}))}finally{await db.end()}`
	if e = decode(originalNode(t, dsn, true, script, index.Endpoint), &identityFixture); e != nil {
		t.Fatal(e)
	}
	subject := str(identityFixture, "subject")
	queue := func() {
		t.Helper()
		if _, e = pool.Exec(ctx, "SELECT public.galaxy_queue_search_source('case',$1,$2)", source, subject); e != nil {
			t.Fatal(e)
		}
	}
	queue()
	result, e := index.ProcessNext(ctx, LegacyProcessOptions{AfterClaim: func(context.Context, LegacyIndexJob) error { queue(); return nil }})
	if e != nil || result["leaseLost"] != true {
		t.Fatalf("superseded generation wrote old cache %v %v", result, e)
	}
	result, e = index.ProcessNext(ctx, LegacyProcessOptions{})
	if e != nil || result["state"] != "hidden" {
		t.Fatalf("current generation not processed %v %v", result, e)
	}
	queue()
	interrupted, stop := context.WithCancel(ctx)
	result, e = index.ProcessNext(interrupted, LegacyProcessOptions{AfterClaim: func(context.Context, LegacyIndexJob) error { stop(); return nil }})
	if e != nil || result["state"] != "pending" || result["interrupted"] != true {
		t.Fatalf("cancelled work not durably released %v %v", result, e)
	}
	var state string
	var lease *string
	if e = pool.QueryRow(ctx, "SELECT state,lease_id::text FROM jobs WHERE payload->>'sourceId'=$1 AND kind='search-index'", source).Scan(&state, &lease); e != nil || state != "pending" || lease != nil {
		t.Fatalf("interrupted lease retained %s %v %v", state, lease, e)
	}
}
