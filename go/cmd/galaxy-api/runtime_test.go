package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
)

func TestReadinessTimeoutRetainsSingleOutstandingCheck(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	defer close(release)
	var calls atomic.Int32
	check := boundedReadiness(ctx, 10*time.Millisecond, func(context.Context) bool {
		calls.Add(1)
		<-release // Deliberately ignores cancellation like the original edge case.
		return true
	})
	if check(ctx) {
		t.Fatal("blocked backend reported ready")
	}
	for range 20 {
		if check(ctx) {
			t.Fatal("timed-out result became ready")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("outstanding probes: %d", calls.Load())
	}
}

func TestMaintenanceImmediateRunCancellationAndJoin(t *testing.T) {
	started, finished := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	stop := startMaintenance(context.Background(), time.Millisecond, func(ctx context.Context) error {
		calls.Add(1)
		close(started)
		<-ctx.Done()
		close(finished)
		return ctx.Err()
	}, func(error) { t.Error("shutdown cancellation logged as maintenance failure") })
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("first check did not start")
	}
	stop()
	stop()
	select {
	case <-finished:
	default:
		t.Fatal("stop returned before current check")
	}
	if calls.Load() != 1 {
		t.Fatal("overlapping or queued maintenance ran")
	}
}

func TestLifecycleProbesAndCombinedStatus(t *testing.T) {
	now := time.Unix(1800000000, 0)
	retired, err := retirement.Load("", retirement.Options{Endpoint: "https://fixture.example.invalid", Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	contained, err := incident.New(&incident.Policy{Version: 1, ID: "fixture", Revision: 1, Endpoint: "https://fixture.example.invalid", State: "contained", UpdatedAt: now.Unix(), PublicMessage: "Maintenance"}, incident.Options{Endpoint: "https://fixture.example.invalid", Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	var business atomic.Int32
	handler := lifecycleHandler(retired, contained, func(context.Context) bool { return true }, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { business.Add(1); w.WriteHeader(204) }))
	for path, status := range map[string]int{"/healthz": 200, "/readyz": 503, "/v1/service-status": 200} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != status {
			t.Fatalf("%s status %d", path, w.Code)
		}
		if path == "/v1/service-status" {
			var value map[string]any
			if json.Unmarshal(w.Body.Bytes(), &value) != nil || value["businessWritesAccepted"] != false || value["downloadsAccepted"] != false || value["incident"].(map[string]any)["state"] != "contained" {
				t.Fatal("combined status lost incident gate")
			}
		}
	}
	if business.Load() != 0 {
		t.Fatal("probe dispatched business work")
	}
}
