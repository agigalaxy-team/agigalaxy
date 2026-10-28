package failureaudit

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func event() Event {
	return Event{RequestID: uuid.NewString(), Status: 503, Route: "POST /v1/cases", ObservedAt: "2033-05-18T03:33:20.000Z"}
}
func mustSpool(t *testing.T, o SpoolOptions) *Spool {
	t.Helper()
	s, e := NewSpool(o)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func flush(t *testing.T, s *Spool) {
	t.Helper()
	if e := s.Flush(context.Background()); e != nil {
		t.Fatal(e)
	}
}
func pending(s *Spool) int {
	v := s.Status()
	if v.Pending == nil {
		return -1
	}
	return *v.Pending
}
func TestDurableSpoolCapacityConflictRecoveryAndClosure(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "audit.sqlite")
	gate := make(chan struct{})
	entered := make(chan struct{}, 1)
	var calls atomic.Int32
	s := mustSpool(t, SpoolOptions{Path: path, Endpoint: "https://fixture.invalid", MaxEvents: 2, Interval: time.Minute, Write: func(context.Context, Event) (Result, error) {
		calls.Add(1)
		select {
		case entered <- struct{}{}:
		default:
		}
		<-gate
		return Result{}, errors.New("PRIVATE-ERROR")
	}})
	first := event()
	if s.Record(ctx, first) != "queued" {
		t.Fatal("commit not queued")
	}
	<-entered
	if s.Record(ctx, first) != "queued" || s.Record(ctx, event()) != "queued" || s.Record(ctx, event()) != "capacity" {
		t.Fatal("capacity/dedup")
	}
	if s.Status().Ready || pending(s) != 2 {
		t.Fatal(s.Status())
	}
	conflict := first
	conflict.Status = 400
	if s.Record(ctx, conflict) != "failed" {
		t.Fatal("conflict accepted")
	}
	done := make(chan error, 1)
	go func() { done <- s.Close() }()
	select {
	case <-done:
		t.Fatal("close dropped active delivery")
	case <-time.After(15 * time.Millisecond):
	}
	close(gate)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 1 || s.Record(ctx, event()) != "closed" || !s.Status().Closed || s.Status().Pending != nil {
		t.Fatal("close replayed or lost state")
	}
	var delivered []Event
	s = mustSpool(t, SpoolOptions{Path: path, Endpoint: "https://fixture.invalid", Interval: time.Minute, BatchSize: 1, Write: func(_ context.Context, e Event) (Result, error) {
		delivered = append(delivered, e)
		return Result{State: "recorded"}, nil
	}})
	flush(t, s)
	if pending(s) != 1 {
		t.Fatal("batch limit", pending(s))
	}
	flush(t, s)
	if pending(s) != 0 || !s.Status().Ready || len(delivered) != 2 || !reflect.DeepEqual(first, delivered[0]) {
		t.Fatal("recovery", s.Status())
	}
	s.Close()
	if _, e := NewSpool(SpoolOptions{Path: path, Endpoint: "https://other.invalid", Write: func(context.Context, Event) (Result, error) { return Result{}, nil }}); e == nil {
		t.Fatal("endpoint switched")
	}
}
func TestBoundedUnknownKeepsSlotWithoutResubmitting(t *testing.T) {
	gate := make(chan struct{})
	settled := make(chan struct{})
	var calls atomic.Int32
	b, e := NewBounded(func(context.Context, Event) (Result, error) {
		if calls.Add(1) == 1 {
			<-gate
			close(settled)
		}
		return Result{State: "suppressed-by-deletion"}, nil
	}, Bounds{Timeout: 10 * time.Millisecond, MaxPending: 1})
	if e != nil {
		t.Fatal(e)
	}
	if b.Record(context.Background(), event()) != "unconfirmed" || b.Record(context.Background(), event()) != "capacity" || calls.Load() != 1 {
		t.Fatal("unknown retried")
	}
	close(gate)
	<-settled
	for {
		b.mu.Lock()
		n := b.pending
		b.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if b.Record(context.Background(), event()) != "suppressed-by-deletion" || calls.Load() != 2 {
		t.Fatal("settle did not release")
	}
}
func TestSpoolCrashHelper(t *testing.T) {
	path := os.Getenv("GALAXY_FAILURE_CRASH_PATH")
	if path == "" {
		return
	}
	s, e := NewSpool(SpoolOptions{Path: path, Endpoint: "https://fixture.invalid", Write: func(context.Context, Event) (Result, error) { select {} }})
	if e != nil {
		os.Exit(2)
	}
	if s.Record(context.Background(), event()) != "queued" {
		os.Exit(3)
	}
	os.Exit(0)
}
func TestActualProcessTerminationRetainsCommittedQueue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.sqlite")
	cmd := exec.Command(os.Args[0], "-test.run=^TestSpoolCrashHelper$")
	cmd.Env = append(os.Environ(), "GALAXY_FAILURE_CRASH_PATH="+path)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatal(e, string(out))
	}
	var n atomic.Int32
	s := mustSpool(t, SpoolOptions{Path: path, Endpoint: "https://fixture.invalid", Write: func(context.Context, Event) (Result, error) { n.Add(1); return Result{State: "recorded"}, nil }})
	flush(t, s)
	if n.Load() != 1 || pending(s) != 0 {
		t.Fatal("crash lost queue")
	}
}
func TestActorSnapshotsStrictReplayAndSafeDiagnostics(t *testing.T) {
	auth := Authentication{Version: 2, Profile: "oauth-resource", Endpoint: "https://fixture.invalid", Audience: "https://fixture.invalid/mcp/personal", ClientID: "external-client", Scope: "binding", BindingScopes: []string{"binding"}, CredentialScopes: []string{"binding"}}
	input := event()
	input.Actor = &Actor{SubjectID: "GUID" + strings.Repeat("A", 28), BindingID: uuid.NewString(), Authentication: &auth}
	copy, e := normalize(input, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	auth.BindingScopes[0] = "untrusted"
	if copy.Actor.Authentication.BindingScopes[0] != "binding" {
		t.Fatal("mutable authentication snapshot")
	}
	raw := encode(copy)
	if _, e = decodeEvent(strings.Replace(raw, `"status":503`, `"status":503,"rawError":"PRIVATE-ERROR"`, 1)); e == nil {
		t.Fatal("unknown replay fields accepted")
	}
	for _, malformed := range []string{strings.Replace(raw, `"actor":`, `"actorMissing":`, 1), strings.Replace(raw, `"authentication":{`, `"authentication":null,"ignored":{`, 1), strings.Replace(raw, `"version":2`, `"version":1`, 1)} {
		if _, e := decodeEvent(malformed); e == nil {
			t.Fatal("strict replay accepted", malformed)
		}
	}
	logs := []Diagnostic{}
	path := filepath.Join(t.TempDir(), "audit.sqlite")
	s := mustSpool(t, SpoolOptions{Path: path, Endpoint: "https://fixture.invalid", Interval: time.Minute, Logger: func(d Diagnostic) { logs = append(logs, d) }, Write: func(context.Context, Event) (Result, error) { return Result{}, errors.New("PRIVATE-ERROR") }})
	bad := event()
	bad.RequestID = "PRIVATE-REQUEST"
	bad.Route = "GET /PRIVATE-TOKEN?code=SECRET"
	if s.Record(context.Background(), bad) != "failed" {
		t.Fatal("unsafe event accepted")
	}
	if strings.Contains(encode(logs), "PRIVATE") || strings.Contains(encode(logs), "SECRET") {
		t.Fatal("private diagnostic")
	}
	if s.Status().Ready {
		t.Fatal("failed storage not unhealthy")
	}
	if s.Record(context.Background(), copy) != "queued" {
		t.Fatal("valid snapshot rejected")
	}
	flush(t, s)
	s.Close()
	db, e := sql.Open("sqlite", path)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var saved string
	db.QueryRow("SELECT event_json FROM pending").Scan(&saved)
	var v Event
	if e = json.Unmarshal([]byte(saved), &v); e != nil || !reflect.DeepEqual(v, copy) {
		t.Fatal("snapshot lost", e)
	}
}
