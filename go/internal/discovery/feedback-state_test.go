package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
)

func TestGorseFeedbackStateUsesRealLikeAndTypeSpecificCancellation(t *testing.T) {
	ctx := context.Background()
	var calls []Object
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body any
		if r.Method != http.MethodDelete {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		calls = append(calls, Object{"method": r.Method, "path": r.URL.Path, "body": body})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	g, e := NewGorse(server.URL, strings.Repeat("synthetic-", 5), ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	state := FeedbackState{ProfileID: "account:11111111-1111-4111-8111-111111111111", ItemKey: "post_22222222-2222-4222-8222-222222222222", Type: "like", Active: true, Revision: 1, OccurredAt: time.Unix(2000000000, 0)}
	if e = g.SyncFeedback(ctx, state); e != nil {
		t.Fatal(e)
	}
	state.Active = false
	if e = g.SyncFeedback(ctx, state); e != nil {
		t.Fatal(e)
	}
	if len(calls) != 3 || calls[0]["path"] != "/api/user" || calls[1]["path"] != "/api/feedback" || calls[2]["path"] != "/api/feedback/like/account:11111111-1111-4111-8111-111111111111/"+state.ItemKey || calls[2]["method"] != "DELETE" {
		t.Fatalf("unexpected feedback contract: %+v", calls)
	}
	rows := calls[1]["body"].([]any)
	if len(rows) != 1 || object(rows[0])["FeedbackType"] != "like" || object(rows[0])["Value"] != float64(1) {
		t.Fatalf("one real like expected: %+v", rows)
	}
	state.Type = "like/../click"
	if e = g.SyncFeedback(ctx, state); fault.Code(e) != "invalid_discovery_request" || len(calls) != 3 {
		t.Fatalf("invalid feedback escaped validation: %v", e)
	}
}

type feedbackSource struct{}

func (feedbackSource) Load(context.Context, Reference) (*Document, error) {
	return &Document{}, nil
}
func (feedbackSource) Candidates(context.Context, string, int) ([]Reference, error) {
	return nil, nil
}

// The actual PostgreSQL lock is exercised while an old add is in flight. The
// cancellation commits without waiting for that request, a second worker may
// not overtake it, and stale source replays cannot restore the add afterwards.
func TestFeedbackStateCancellationSupersedesInFlightAdd(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if _, e := databaseschema.Migrate(ctx, pool, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	store := &Store{Pool: pool, Endpoint: "https://feedback.example.invalid"}
	state := FeedbackState{ProfileID: "account:11111111-1111-4111-8111-111111111111", ItemKey: "post_22222222-2222-4222-8222-222222222222", Type: "like", Active: true, Revision: 1, OccurredAt: time.Unix(2000000000, 0)}
	queue := func(value FeedbackState) error {
		tx, e := pool.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(context.Background())
		if e = store.QueueFeedbackStateWithin(ctx, tx, value); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	if e := queue(state); e != nil {
		t.Fatal(e)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	var mu sync.Mutex
	var interactions []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		if r.Method == http.MethodPut || r.Method == http.MethodDelete {
			mu.Lock()
			interactions = append(interactions, r.Method+" "+r.URL.Path)
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	g, e := NewGorse(server.URL, strings.Repeat("synthetic-", 5), ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	w := &Worker{Runtime: &Runtime{Store: store, Source: feedbackSource{}, Gorse: g}}
	first := make(chan error, 1)
	go func() { _, e := w.deliverFeedbackState(ctx); first <- e }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	state.Active, state.Revision = false, 2
	if e = queue(state); e != nil {
		t.Fatal("source cancellation could not commit during network call", e)
	}
	if result, e := w.deliverFeedbackState(ctx); e != nil || result["state"] != "idle" {
		t.Fatalf("a second worker overtook the relation lock: %+v %v", result, e)
	}
	unblock()
	if e = <-first; e != nil {
		t.Fatal(e)
	}
	if result, e := w.deliverFeedbackState(ctx); e != nil || result["state"] != "delivered" {
		t.Fatalf("cancel did not reach engine: %+v %v", result, e)
	}
	state.Active, state.Revision = true, 1
	if e = queue(state); e != nil {
		t.Fatal(e)
	}
	if result, e := w.deliverFeedbackState(ctx); e != nil || result["state"] != "idle" {
		t.Fatalf("late add replay became pending: %+v %v", result, e)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(interactions) != 2 || interactions[0] != "PUT /api/feedback" || interactions[1] != "DELETE /api/feedback/like/"+state.ProfileID+"/"+state.ItemKey {
		t.Fatalf("wrong remote order or broad deletion: %+v", interactions)
	}
	state.Revision = 2
	if e = queue(state); fault.Code(e) != "discovery_feedback_revision_conflict" {
		t.Fatalf("conflicting same revision was accepted: %v", e)
	}
	// Closing the transaction used by a source operation must also discard its
	// feedback state; otherwise a failed business command could leak a like.
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	state.Revision = 3
	if e = store.QueueFeedbackStateWithin(ctx, tx, state); e != nil {
		t.Fatal(e)
	}
	if e = tx.Rollback(ctx); e != nil && e != pgx.ErrTxClosed {
		t.Fatal(e)
	}
	if result, e := w.deliverFeedbackState(ctx); e != nil || result["state"] != "idle" {
		t.Fatalf("rolled-back source queued feedback: %+v %v", result, e)
	}
}

// Source visibility is independent of the user's durable like revision. The
// outbox generation drives typed removal and later restoration, including a
// source change while an earlier remote request is still in flight.
type feedbackEligibilitySource struct {
	available atomic.Bool
	failure   atomic.Bool
}

func (s *feedbackEligibilitySource) Load(context.Context, Reference) (*Document, error) {
	if s.failure.Load() {
		return nil, fail("source_temporary_error")
	}
	if !s.available.Load() {
		return nil, nil
	}
	return &Document{}, nil
}
func (*feedbackEligibilitySource) Candidates(context.Context, string, int) ([]Reference, error) {
	return nil, nil
}
func TestFeedbackVisibilityReconcilesAndFencesInFlightGeneration(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if _, e := databaseschema.Migrate(ctx, pool, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	testNow := time.Now().UTC().Add(time.Minute)
	store := &Store{Pool: pool, Endpoint: "https://feedback-visibility.example.invalid", Now: func() time.Time { return testNow }}
	state := FeedbackState{ProfileID: "account:11111111-1111-4111-8111-111111111111", ItemKey: "post_22222222-2222-4222-8222-222222222222", Type: "like", Active: true, Revision: 1, OccurredAt: time.Unix(2000000000, 0)}
	if _, e := pool.Exec(ctx, `INSERT INTO discovery_index_outbox_v1(endpoint,kind,source_id) VALUES($1,'post',$2)`, store.Endpoint, "22222222-2222-4222-8222-222222222222"); e != nil {
		t.Fatal(e)
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = store.QueueFeedbackStateWithin(ctx, tx, state); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	changed := func() {
		t.Helper()
		var before, after, applied int64
		if e := pool.QueryRow(ctx, `SELECT delivery_generation FROM discovery_feedback_state_v1 WHERE endpoint=$1`, store.Endpoint).Scan(&before); e != nil {
			t.Fatal(e)
		}
		if _, e := pool.Exec(ctx, `UPDATE discovery_index_outbox_v1 SET generation=generation+1 WHERE endpoint=$1 AND kind='post' AND source_id=$2`, store.Endpoint, "22222222-2222-4222-8222-222222222222"); e != nil {
			t.Fatal(e)
		}
		if e := pool.QueryRow(ctx, `SELECT delivery_generation,applied_generation FROM discovery_feedback_state_v1 WHERE endpoint=$1`, store.Endpoint).Scan(&after, &applied); e != nil {
			t.Fatal(e)
		}
		if after != before+1 || after <= applied {
			t.Fatalf("source change did not enqueue feedback generation: before=%d after=%d applied=%d", before, after, applied)
		}
	}
	source := &feedbackEligibilitySource{}
	source.available.Store(true)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	var block atomic.Bool
	var mu sync.Mutex
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && block.CompareAndSwap(true, false) {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		if r.Method == http.MethodPut || r.Method == http.MethodDelete {
			mu.Lock()
			calls = append(calls, r.Method+" "+r.URL.Path)
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	g, e := NewGorse(server.URL, strings.Repeat("synthetic-", 5), ClientOptions{})
	if e != nil {
		t.Fatal(e)
	}
	worker := &Worker{Runtime: &Runtime{Store: store, Source: source, Gorse: g}}
	deliver := func(want string) {
		t.Helper()
		got, e := worker.deliverFeedbackState(ctx)
		if e != nil || got["state"] != want {
			t.Fatalf("feedback state %v, want %s: %v", got, want, e)
		}
	}
	deliver("delivered")
	source.available.Store(false)
	changed()
	deliver("delivered")
	source.available.Store(true)
	changed()
	deliver("delivered")
	// A transient source failure is not evidence that the source became private.
	source.failure.Store(true)
	changed()
	deliver("failed")
	source.failure.Store(false)
	if _, e = pool.Exec(ctx, `UPDATE discovery_feedback_state_v1 SET next_attempt_at=$2 WHERE endpoint=$1`, store.Endpoint, store.now()); e != nil {
		t.Fatal(e)
	}
	block.Store(true)
	first := make(chan Object, 1)
	errs := make(chan error, 1)
	go func() { v, e := worker.deliverFeedbackState(ctx); first <- v; errs <- e }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	source.available.Store(false)
	changed()
	once.Do(func() { close(release) })
	result := <-first
	if e = <-errs; e != nil || result["state"] != "source-changed" {
		t.Fatalf("old generation settled: %v %v", result, e)
	}
	deliver("delivered")
	var desired bool
	var revision, generation, applied int64
	if e = pool.QueryRow(ctx, `SELECT desired_active,revision,delivery_generation,applied_generation FROM discovery_feedback_state_v1 WHERE endpoint=$1`, store.Endpoint).Scan(&desired, &revision, &generation, &applied); e != nil {
		t.Fatal(e)
	}
	if !desired || revision != 1 || generation != applied {
		t.Fatalf("source relation changed or generation unsettled: %v %d %d/%d", desired, revision, generation, applied)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"PUT /api/feedback", "DELETE /api/feedback/like/" + state.ProfileID + "/" + state.ItemKey, "PUT /api/feedback", "PUT /api/feedback", "DELETE /api/feedback/like/" + state.ProfileID + "/" + state.ItemKey}
	if len(calls) != len(want) {
		t.Fatalf("remote calls %v", calls)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Fatalf("remote calls %v", calls)
		}
	}
}
