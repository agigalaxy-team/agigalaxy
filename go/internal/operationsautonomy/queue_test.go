package operationsautonomy_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	a "github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/autonomyfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTickOriginalCatchUpAndRealRiverWorkerRole(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	f := operationsfixture.NewEndpoint(t, admin, "https://autonomy.example.invalid")
	automation := f.Automation(t)
	autonomyfixture.Setup(t, f, automation)
	endpoint := f.Endpoint
	if _, e := databaseschema.Migrate(ctx, admin, []string{"worker"}); e != nil {
		t.Fatal(e)
	}
	tx, e := admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, admin, tx); e == nil {
		e = jobs.ProvisionRolesWithin(ctx, tx)
	}
	if e == nil {
		_, e = tx.Exec(ctx, `INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')`, endpoint)
	}
	if e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	at := time.Now().UTC().Truncate(time.Second)
	now := func() time.Time { return at }
	s := &a.Service{Pool: pool, Endpoint: endpoint, AIWork: &operationsai.Service{Endpoint: endpoint}, Now: now}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	e = s.EnsureWithin(ctx, tx)
	if e == nil {
		e = tx.Commit(ctx)
	} else {
		tx.Rollback(ctx)
	}
	if e != nil {
		t.Fatal(e)
	}
	due := at.Add(-time.Hour)
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true,configuration=jsonb_set(jsonb_set(configuration,'{enabled}','true'),'{mode}','"ai"'),next_due_at=$2 WHERE endpoint=$1 AND domain='overview'`, endpoint, due); e != nil {
		t.Fatal(e)
	}
	var posts, gets atomic.Int32
	var retryReady atomic.Bool
	var retryTask, retryRun, retrySession string
	postClaims := make(chan a.Object, 4)
	retryPayload := make(chan a.Object, 4)
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts.Add(1)
			if retryReady.Load() {
				parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
				claims := a.Object{}
				if len(parts) == 3 {
					raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
					_ = json.Unmarshal(raw, &claims)
				}
				claims["idempotencyKey"] = r.Header.Get("Idempotency-Key")
				postClaims <- claims
			}
		} else {
			gets.Add(1)
			if retryReady.Load() {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(a.Object{"taskId": retryTask, "nativeRunId": retryRun, "sessionId": retrySession, "status": "ERROR"})
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(a.Object{"nativeRunId": "river-original-run", "status": "RUNNING", "modelState": "running"})
	}))
	defer native.Close()
	client, e := agentos.New(agentos.Configuration{URL: native.URL, SigningKey: strings.Repeat("s", 32), ServiceKey: strings.Repeat("v", 32)}, agentos.Options{Now: now})
	if e != nil {
		t.Fatal(e)
	}
	s.Native = &a.NativeClient{Client: client}
	worker := a.NewWorker(s)
	var q *jobs.Queue
	q, e = jobs.NewWithQueues(pool, func(ctx context.Context, task jobs.Task) (jobs.Outcome, error) {
		if task.Action == jobs.AutonomyTask {
			if retryReady.Load() {
				retryPayload <- task.Payload
			}
			if task.Payload["taskId"] != task.SourceID {
				t.Error("River ID replaced business task")
			}
			out, e := worker.Execute(ctx, task.Payload)
			return jobs.Outcome{Result: out}, e
		}
		out, e := worker.Tick(ctx)
		return jobs.Outcome{Result: out}, e
	}, map[string]int{jobs.AutonomyTask: 1, jobs.AutonomyTick: 1})
	if e != nil {
		t.Fatal(e)
	}
	s.EnqueueWithin = func(ctx context.Context, tx pgx.Tx, queue string, payload a.Object, key string, start *time.Time) error {
		return q.EnqueueAutonomyWithin(ctx, tx, endpoint, queue, payload, key, start)
	}
	for i := 0; i < 2; i++ {
		out, e := worker.Tick(ctx)
		if e != nil || out["state"] != "checked" {
			t.Fatalf("tick %v %#v", e, out)
		}
	}
	var n int
	var taskID string
	var frozenDue, next time.Time
	if e = admin.QueryRow(ctx, `SELECT count(*),min(id::text),min(due_at) FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND source='routine'`, endpoint).Scan(&n, &taskID, &frozenDue); e != nil || n != 1 || !frozenDue.Equal(due) {
		t.Fatalf("catch-up count%d due%v %v", n, frozenDue, e)
	}
	if e = admin.QueryRow(ctx, `SELECT next_due_at FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND domain='overview'`, endpoint).Scan(&next); e != nil || !next.Equal(at.Add(30*time.Minute)) {
		t.Fatalf("next due %v %v", next, e)
	}
	var generations int
	if e = admin.QueryRow(ctx, `SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND action='autonomy-task' AND source_id=$2`, endpoint, taskID).Scan(&generations); e != nil || generations != 2 {
		t.Fatalf("original task/health technical queue rows %d %v", generations, e)
	}
	if e = q.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer q.Stop(context.Background())
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var finished int
		e = admin.QueryRow(ctx, `SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND action='autonomy-task' AND source_id=$2 AND state='succeeded'`, endpoint, taskID).Scan(&finished)
		if e != nil {
			t.Fatal(e)
		}
		if finished == 2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(25 * time.Millisecond):
		}
	}
	if posts.Load() != 1 || gets.Load() != 1 {
		t.Fatalf("real River original dispatch POST%d GET%d", posts.Load(), gets.Load())
	}
	var completed int
	if e = admin.QueryRow(ctx, `SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE endpoint=$1 AND action='autonomy-task' AND source_id=$2 AND state='succeeded'`, endpoint, taskID).Scan(&completed); e != nil || completed != 2 {
		t.Fatalf("real worker-role acknowledgments%d %v", completed, e)
	}
	var enabled int
	if e = admin.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND domain<>'overview' AND enabled`, endpoint).Scan(&enabled); e != nil || enabled != 0 {
		t.Fatalf("new plans enabled%d %v", enabled, e)
	}
	// Exercise the formal retry through the same River registration and transport.
	retryTask, retryRun, retrySession = taskID, "river-original-run", uuid.NewString()
	if _, e = admin.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='failed',session_id=$3,native_run_id=$4,dispatch_started_at=$5,lease_owner=NULL,lease_until=NULL WHERE endpoint=$1 AND id=$2`, endpoint, taskID, retrySession, retryRun, at); e != nil {
		t.Fatal(e)
	}
	retryReady.Store(true)
	control := &a.Service{Pool: f.Pool, Endpoint: endpoint, AIWork: s.AIWork, Authority: f.Gateway, Now: now, Native: s.Native, EnqueueWithin: s.EnqueueWithin}
	control.Permissions = &operationspermissions.Service{Pool: f.Pool, Endpoint: endpoint, Authority: f.Gateway, StoredAuthority: f.Gateway, AIWork: s.AIWork, Duty: control, Now: now}
	var rev int64
	if e = admin.QueryRow(ctx, `SELECT revision FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, endpoint, taskID).Scan(&rev); e != nil {
		t.Fatal(e)
	}
	attempt := uuid.NewString()
	if _, e = control.Control(ctx, f.Root, taskID, a.Object{"kind": "retry", "operationId": attempt, "expectedRevision": rev}, nil); e != nil {
		t.Fatal(e)
	}
	var nextSession string
	if e = admin.QueryRow(ctx, `SELECT session_id FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, endpoint, taskID).Scan(&nextSession); e != nil || nextSession == retrySession {
		t.Fatalf("retry session %s: %v", nextSession, e)
	}
	select {
	case payload := <-retryPayload:
		if payload["taskId"] != taskID || payload["nativeAttemptId"] != attempt || payload["sessionId"] != nextSession {
			t.Fatalf("retry queue tuple: %v", payload)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case claims := <-postClaims:
		if claims["taskId"] != taskID || claims["nativeAttemptId"] != attempt || claims["idempotencyKey"] != attempt {
			t.Fatalf("retry transport: %v", claims)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var currentState string
	if e = admin.QueryRow(ctx, `SELECT state FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, endpoint, taskID).Scan(&currentState); e != nil {
		t.Fatal(e)
	}
	postCount, getCount := posts.Load(), gets.Load()
	for _, input := range []a.Object{{"taskId": taskID}, {"taskId": taskID, "nativeAttemptId": uuid.NewString(), "sessionId": nextSession}, {"taskId": taskID, "nativeAttemptId": attempt, "sessionId": retrySession}} {
		out, err := worker.Execute(ctx, input)
		if err != nil || out["state"] != currentState {
			t.Fatalf("stale attempt: %v %v", out, err)
		}
	}
	if posts.Load() != postCount || gets.Load() != getCount {
		t.Fatal("stale tuple reached native transport")
	}
	select {
	case claims := <-postClaims:
		t.Fatalf("stale attempt dispatched: %v", claims)
	default:
	}
}

func TestTickDefersEventWhenRoutineCreatedAndFiltersBeforeLimit(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.NewEndpoint(t, pool, "https://autonomy-scheduling.example.invalid")
	autonomyfixture.Setup(t, f, f.Automation(t))
	at := time.Now().UTC().Truncate(time.Second)
	s := &a.Service{Pool: pool, Endpoint: f.Endpoint, AIWork: &operationsai.Service{Endpoint: f.Endpoint}, Now: func() time.Time { return at }}
	s.EnqueueWithin = func(context.Context, pgx.Tx, string, a.Object, string, *time.Time) error { return nil }
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) { return true, s.EnsureWithin(ctx, tx) }); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET enabled=true,configuration=jsonb_set(configuration,'{plan,eventTypes}','["feedback.changed"]'),next_due_at=$2 WHERE endpoint=$1 AND domain='overview'`, f.Endpoint, at.Add(-time.Minute)); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 101; i++ {
		if _, e := pool.Exec(ctx, `INSERT INTO operations_autonomy_events_v1(id,endpoint,domain,event_key,event_type,created_at,available_at) VALUES(gen_random_uuid(),$1,'overview',$2,'other.changed',$3,$3)`, f.Endpoint, fmt.Sprintf("other:%d", i), at.Add(-time.Hour)); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := pool.Exec(ctx, `INSERT INTO operations_autonomy_events_v1(id,endpoint,domain,event_key,event_type,created_at,available_at) VALUES(gen_random_uuid(),$1,'overview','eligible','feedback.changed',$2,$2)`, f.Endpoint, at.Add(-time.Minute)); e != nil {
		t.Fatal(e)
	}
	worker := a.NewWorker(s)
	if _, e := worker.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	var routine, events int
	if e := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE source='routine'),count(*) FILTER (WHERE source='event') FROM operations_autonomy_tasks_v1 WHERE endpoint=$1`, f.Endpoint).Scan(&routine, &events); e != nil || routine != 1 || events != 0 {
		t.Fatalf("same tick routine=%d events=%d: %v", routine, events, e)
	}
	if _, e := pool.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='completed' WHERE endpoint=$1 AND source='routine'`, f.Endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e := worker.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	var processed bool
	if e := pool.QueryRow(ctx, `SELECT processed_at IS NOT NULL FROM operations_autonomy_events_v1 WHERE endpoint=$1 AND event_key='eligible'`, f.Endpoint).Scan(&processed); e != nil || !processed {
		t.Fatalf("subscribed event starved: %v %v", processed, e)
	}
	if e := pool.QueryRow(ctx, `SELECT count(*) FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND source='event'`, f.Endpoint).Scan(&events); e != nil || events != 1 {
		t.Fatalf("event tasks=%d: %v", events, e)
	}
}
