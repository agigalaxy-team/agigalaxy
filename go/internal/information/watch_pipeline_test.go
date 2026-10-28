package information

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

func same(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(encode(a), &x)
	_ = json.Unmarshal(encode(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", encode(a), encode(b))
	}
}
func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	until := time.Now().Add(15 * time.Second)
	for time.Now().Before(until) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("bounded River completion expired")
}
func TestInformationCurrentSourcesCommandsAndRiverSameWatchRecovery(t *testing.T) {
	owner, api, dsn, path, f := setup(t)
	ctx := context.Background()
	var logical atomic.Int64
	logical.Store(f.Clock)
	now := func() time.Time { return time.Unix(logical.Load(), 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: f.Endpoint, Now: now}
	actor, e := devices.Authenticate(ctx, f.Owner.Token, "notifications")
	if e != nil {
		t.Fatal(e)
	}
	cs := &cases.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	config := &configurations.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	cs.ConfigurationCondition = config.ConditionWithin
	tasks := &taskmaterials.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	hs := &historyv2.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Tasks: tasks.ReadHistoryWireWithin, Profiles: &profiles.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}, Now: now}
	search := &searchv2.Service{Pool: api, Devices: devices, History: hs, Now: now}
	search.Tasks = func(ctx context.Context, a *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
		var q Object
		if e := protocol.Decode(raw, &q); e != nil {
			return nil, e
		}
		var ta *taskmaterials.Actor
		if a != nil {
			ta = &taskmaterials.Actor{Actor: *a}
		}
		return tasks.QueryTasksWire(ctx, ta, text(q, "view"), text(q, "query"), text(q, "after"), int(number(q, "limit")))
	}
	info := &Service{Endpoint: f.Endpoint, Search: search, Now: now}
	w := &Watches{Pool: api, Devices: devices, Information: info, Now: now}
	queries := []Object{{"kind": "query", "actor": true, "input": Object{"purpose": "Independent permitted sources", "sources": obj(f.Watches[0].Command["plan"])["sources"]}}, {"kind": "query", "input": Object{"purpose": "Only permitted facts", "sources": []any{Object{"key": "history", "source": Object{"kind": "search", "request": Object{"type": "history", "query": Object{"limit": 1}}}}}}}, {"kind": "list", "actor": true, "input": Object{"watchId": f.Watches[0].Command["watchId"]}}}
	expected := list(node(t, dsn, "read", path, Object{"clock": logical.Load(), "queries": queries})["results"])
	for i, q := range queries {
		var got Object
		var e error
		if q["kind"] == "query" {
			var a *deviceauth.Actor
			if q["actor"] == true {
				a = &actor
			}
			got, e = info.Query(ctx, a, encode(q["input"]))
		} else {
			got, e = w.List(ctx, actor, encode(q["input"]))
		}
		if e != nil {
			t.Fatal(e)
		}
		same(t, got, obj(expected[i])["value"])
	}
	query := obj(queries[0]["input"])
	page, e := info.Query(ctx, &actor, encode(query))
	if e != nil {
		t.Fatal(e)
	}
	changed := copyObject(query)
	changed["queryId"] = page["queryId"]
	changed["purpose"] = "A different purpose"
	if _, e = info.Query(ctx, &actor, encode(changed)); fault.Code(e) != "information_query_scope_changed" {
		t.Fatal(e)
	}
	for _, stored := range f.Watches {
		if _, e = w.Stop(ctx, actor, encode(Object{"operationId": uuid.NewString(), "watchId": stored.Command["watchId"], "expectedRevision": 1, "action": "pause"}), ""); e != nil {
			t.Fatal(e)
		}
	}
	// Explicit technical DDL and role provisioning occur only in this disposable
	// cluster. Node setup has exited and no original scheduler was started.
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
	if _, e = owner.Exec(ctx, `INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')`, f.Endpoint); e != nil {
		t.Fatal(e)
	}
	transportConfig := owner.Config()
	transportConfig.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	transport, e := pgxpool.NewWithConfig(ctx, transportConfig)
	if e != nil {
		t.Fatal(e)
	}
	defer transport.Close()
	var servicePaused atomic.Bool
	servicePaused.Store(true)
	w.CanProcessBackground = func() bool { return !servicePaused.Load() }
	q, e := jobs.NewWithQueues(transport, func(ctx context.Context, t jobs.Task) (jobs.Outcome, error) {
		if t.Action != jobs.InformationWatch || t.SourceID != t.Payload["watchId"] {
			return jobs.Outcome{}, fmt.Errorf("watch identity changed")
		}
		result, e := w.ProcessJob(ctx, t.Payload)
		return jobs.Outcome{Result: result}, e
	}, map[string]int{jobs.InformationWatch: 1})
	if e != nil {
		t.Fatal(e)
	}
	producer := func(ctx context.Context, tx pgx.Tx, key string, data Object, startAfter time.Time) error {
		// The source fixture uses a fixed logical clock. Only transport availability
		// is mapped to wall time; original next_check_at/deadlines remain untouched.
		available := time.Now().Add(startAfter.Sub(now()))
		return q.EnqueueInformationWatchWithin(ctx, tx, f.Endpoint, data, key, available)
	}
	w.Tasks = producer
	w.HasOutstanding = func(ctx context.Context, tx pgx.Tx, id string, revision, checkRevision int64) (bool, error) {
		return q.HasInformationWatchOutstandingWithin(ctx, tx, f.Endpoint, id, revision, checkRevision)
	}
	rollback := copyObject(f.Simple)
	rollback["watchId"] = uuid.NewString()
	rollback["operationId"] = uuid.NewString()
	w.Tasks = func(ctx context.Context, tx pgx.Tx, key string, data Object, at time.Time) error {
		if e := producer(ctx, tx, key, data, at); e != nil {
			return e
		}
		return fault.New("controlled_enqueue_failure", 503)
	}
	if _, e = w.Command(ctx, actor, encode(rollback), ""); fault.Code(e) != "controlled_enqueue_failure" {
		t.Fatalf("producer rollback=%v", e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM information_watches_v2 WHERE id=$1`, rollback["watchId"]).Scan(&count); e != nil || count != 0 {
		t.Fatalf("watch rolled-back count=%d %v", count, e)
	}
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM galaxy_river.river_job`).Scan(&count); e != nil || count != 0 {
		t.Fatalf("River rolled-back count=%d %v", count, e)
	}
	w.Tasks = producer
	created, e := w.Command(ctx, actor, encode(f.Simple), "")
	if e != nil {
		t.Fatal(e)
	}
	replay, e := w.Command(ctx, actor, encode(f.Simple), "")
	if e != nil || replay["replayed"] != true {
		t.Fatalf("same command replay %v %v", replay, e)
	}
	receipt := Object{"operationId": f.Simple["operationId"], "requestHash": created["requestHash"]}
	ack, e := w.Receipt(ctx, actor, encode(receipt))
	if e != nil || ack["state"] != "acknowledged" {
		t.Fatalf("receipt %v %v", ack, e)
	}
	originalReceipt := node(t, dsn, "read", path, Object{"queries": []any{Object{"actor": true, "kind": "receipt", "input": receipt}}})
	same(t, ack, obj(list(originalReceipt["results"])[0])["value"])
	h := Handler{Service: info, Watches: w, Devices: devices}
	requestReceipt := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v2/information/watches/receipt", bytes.NewReader(encode(receipt)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+f.Owner.Token)
		response := httptest.NewRecorder()
		h.ServeHTTP(response, r)
		return response
	}
	if response := requestReceipt(); response.Code != 200 {
		t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
	}
	watchID := text(f.Simple, "watchId")
	key := fmt.Sprintf("watch:%s:1:0", watchID)
	slot := func(key string) string {
		t.Helper()
		var id string
		if e := owner.QueryRow(ctx, `SELECT execution_id::text FROM galaxy_go_jobs.singleton_slots_v1 WHERE endpoint=$1 AND action='information-watch' AND slot_key=$2`, f.Endpoint, key).Scan(&id); e != nil {
			t.Fatal(e)
		}
		return id
	}
	firstID := slot(key)
	if e = q.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer q.Stop(context.Background())
	wait := func(id, state string) {
		t.Helper()
		eventually(t, func() bool {
			view, e := q.Get(ctx, f.Endpoint, id)
			if e != nil || view.State != "succeeded" || view.Result["state"] != state {
				return false
			}
			completed, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (bool, error) {
				job, e := q.GetTransportWithin(ctx, tx, f.Endpoint, id)
				return e == nil && string(job.State) == "completed", e
			})
			return e == nil && completed
		})
	}
	wait(firstID, "service-paused")
	servicePaused.Store(false)
	// Controlled early delivery of that same accepted key exercises not-due.
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
		return nil, q.EnqueueInformationWatchWithin(ctx, tx, f.Endpoint, Object{"watchId": watchID, "subjectId": f.Owner.Subject, "revision": 1, "checkRevision": 0}, key, time.Now())
	})
	if e != nil {
		t.Fatal(e)
	}
	secondID := slot(key)
	if secondID == firstID {
		t.Fatal("terminal technical key permanently suppressed original watch")
	}
	wait(secondID, "not-due")
	logical.Add(61)
	if result, e := w.Reconcile(ctx); e != nil || number(result, "queued") != 1 {
		t.Fatalf("due reconciliation %v %v", result, e)
	}
	thirdID := slot(key)
	if thirdID == secondID {
		t.Fatal("terminal not-due generation suppressed original reconciliation")
	}
	wait(thirdID, "unchanged")
	nextKey := fmt.Sprintf("watch:%s:1:1", watchID)
	slot(nextKey)
	reconciled, e := w.Reconcile(ctx)
	if e != nil || number(reconciled, "queued") != 0 {
		t.Fatalf("future/current work requeued %v %v", reconciled, e)
	}
	if _, e = cs.SubmitV2(ctx, actor, encode(f.NewCaseGrant), ""); e != nil {
		t.Fatal(e)
	}
	logical.Add(901)
	// The original temporary credential has expired by this next interval.
	// Background processing must use its accepted, currently rechecked authority.
	if _, e = devices.Authenticate(ctx, f.Owner.Token, "notifications"); fault.Code(e) != "access_denied" {
		t.Fatalf("expired temporary credential %v", e)
	}
	actor, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (deviceauth.Actor, error) {
		return devices.NewInformationWatchActor(ctx, tx, watchID, f.Owner.Subject, 1)
	})
	if e != nil {
		t.Fatal(e)
	}
	changedResult, e := w.Check(ctx, actor, encode(Object{"watchId": watchID, "expectedRevision": 1}))
	if e != nil || changedResult["state"] != "changed" {
		t.Fatalf("real changed sources %v %v", changedResult, e)
	}
	eventID := text(changedResult, "eventId")
	if eventID == "" {
		t.Fatal("change receipt absent")
	}
	event, e := w.Events(ctx, actor, encode(Object{"watchId": watchID}))
	if e != nil {
		t.Fatal(e)
	}
	if len(list(event["events"])) == 0 {
		t.Fatal("source change receipt not readable")
	}
	notification, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return w.NotificationWithin(ctx, tx, actor, eventID) })
	if e != nil || notification["receiptOnly"] != true {
		t.Fatalf("inbox current receipt %v %v", notification, e)
	}
	var leaked bool
	if e = owner.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_watch_changes_v2 WHERE changes::text LIKE '%Private selected watch source%')`).Scan(&leaked); e != nil || leaked {
		t.Fatal("stored source body instead of private receipt", e)
	}
	if _, e = owner.Exec(ctx, `UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1`, f.NewCaseGrant["consentId"], logical.Load()); e != nil {
		t.Fatal(e)
	}
	event, e = w.Events(ctx, actor, encode(Object{"watchId": watchID}))
	if e != nil {
		t.Fatal(e)
	}
	for _, entry := range list(event["events"]) {
		for _, change := range list(obj(entry)["changes"]) {
			if obj(change)["id"] == f.NewCase["caseId"] {
				t.Fatal("old private source ID survived current permission loss")
			}
		}
	}
	if ack2, e := w.Receipt(ctx, actor, encode(receipt)); e != nil {
		t.Fatal(e)
	} else {
		same(t, ack2, ack)
	}
	response := requestReceipt()
	if response.Code != 401 {
		t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
	}
}
