package runtimelog

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5/pgconn"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestActualFileRotationRestartDailyAndAdjacentPreservation(t *testing.T) {
	dir := t.TempDir()
	at := time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC)
	now := func() time.Time { return at }
	options := Options{Component: "api", Configuration: Configuration{Directory: dir, RotateBytes: 1024, MaxFiles: 2, Environment: "test"}, Release: "0.1.22", Now: now}
	logger, e := New(options)
	if e != nil {
		t.Fatal(e)
	}
	own := filepath.Join(dir, "api-primary")
	keep := filepath.Join(own, "keep.txt")
	os.WriteFile(keep, []byte("unrelated"), 0600)
	for i := 0; i < 300; i++ {
		logger.Write(Event{"event": "expired_exports_removed", "count": i, "body": "PRIVATE-BODY", "authorization": "PRIVATE-TOKEN"})
	}
	if e = logger.Close(); e != nil {
		t.Fatal(e)
	}
	if logger.Status().Rotations <= 2 || logger.Status().Ready {
		t.Fatal(logger.Status())
	}
	read := func() []Event {
		t.Helper()
		entries, e := os.ReadDir(own)
		if e != nil {
			t.Fatal(e)
		}
		archives := 0
		rows := []Event{}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".jsonl") && !strings.HasSuffix(name, ".gz") {
				continue
			}
			raw, e := os.ReadFile(filepath.Join(own, name))
			if e != nil {
				t.Fatal(e)
			}
			if strings.HasSuffix(name, ".gz") {
				archives++
				z, e := gzip.NewReader(bytes.NewReader(raw))
				if e != nil {
					t.Fatal(e)
				}
				raw, e = io.ReadAll(z)
				z.Close()
				if e != nil {
					t.Fatal(e)
				}
			}
			if strings.Contains(string(raw), "PRIVATE") {
				t.Fatal("private data logged")
			}
			for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
				if line == "" {
					continue
				}
				var row Event
				if e = json.Unmarshal([]byte(line), &row); e != nil {
					t.Fatal(e)
				}
				rows = append(rows, row)
			}
		}
		if archives != 2 {
			t.Fatal("archive cap", archives)
		}
		return rows
	}
	rows := read()
	max := 0
	for _, row := range rows {
		if row["component"] != "api" || row["release"] != "0.1.22" || row["environment"] != "test" {
			t.Fatal("context")
		}
		n := int(row["count"].(float64))
		if n > max {
			max = n
		}
	}
	if max != 299 {
		t.Fatal("last accepted record not drained", max)
	}
	at = at.Add(24 * time.Hour)
	logger, e = New(options)
	if e != nil {
		t.Fatal(e)
	}
	logger.Write(Event{"event": "expired_exports_removed", "count": 300})
	logger.Close()
	read()
	raw, _ := os.ReadFile(keep)
	if string(raw) != "unrelated" {
		t.Fatal("adjacent changed")
	}
}

type blockingSink struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	bytes   bytes.Buffer
}

func (s *blockingSink) Write(p []byte) (int, error) {
	s.once.Do(func() { close(s.entered); <-s.release })
	return s.bytes.Write(p)
}
func TestBoundedBufferBlockedSinkAndSafeFallbackOnce(t *testing.T) {
	sink := &blockingSink{entered: make(chan struct{}), release: make(chan struct{})}
	var fallback bytes.Buffer
	logger, e := New(Options{Component: "api", Destination: sink, Fallback: &fallback, MaxBufferedBytes: 1024})
	if e != nil {
		t.Fatal(e)
	}
	logger.Write(Event{"status": 500, "code": "PRIVATE-ERROR", "body": "PRIVATE-INPUT"})
	<-sink.entered
	for i := 0; i < 30; i++ {
		logger.Write(Event{"status": 500, "code": "PRIVATE-ERROR"})
	}
	state := logger.Status()
	logger.mu.Lock()
	n := logger.buffered
	logger.mu.Unlock()
	if state.DroppedRecords == 0 || n > 1024 {
		t.Fatal(state, n)
	}
	done := make(chan error, 1)
	go func() { done <- logger.Close() }()
	select {
	case <-done:
		t.Fatal("close did not drain")
	case <-time.After(10 * time.Millisecond):
	}
	close(sink.release)
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	if strings.Count(fallback.String(), "runtime_log_sink_unavailable") != 1 || strings.Contains(sink.bytes.String()+fallback.String(), "PRIVATE") {
		t.Fatal("unsafe fallback")
	}
}

type failingSink struct{}

func (failingSink) Write([]byte) (int, error) { return 0, errors.New("PRIVATE-DISK-PATH") }
func TestSinkFailureStatusSlogAndSafeCauses(t *testing.T) {
	var fallback bytes.Buffer
	logger, e := New(Options{Component: "worker", Destination: failingSink{}, Fallback: &fallback})
	if e != nil {
		t.Fatal(e)
	}
	logger.Write(Event{"event": "evidence_job_failed", "error": errors.New("PRIVATE")})
	logger.Close()
	state := logger.Status()
	if state.Ready || state.WriteFailures != 1 || strings.Contains(fallback.String(), "PRIVATE") {
		t.Fatal(state)
	}
	var output bytes.Buffer
	logger, e = New(Options{Component: "api", Destination: &output})
	if e != nil {
		t.Fatal(e)
	}
	ctx := WithContext(context.Background(), Event{"requestId": "11111111-1111-4111-8111-111111111111", "stage": "database", "body": "PRIVATE-CONTEXT"})
	slog.New(logger.Handler()).ErrorContext(ctx, "database_pool_failed", "error", fmt.Errorf("PRIVATE-WRAPPER: %w", &pgconn.PgError{Code: "23505", Message: "PRIVATE-MESSAGE", Detail: "PRIVATE-DETAIL"}), "headers", "PRIVATE-HEADER")
	logger.Write(Event{"event": "startup_failed", "error": fault.New("invalid_request", 400)})
	logger.Close()
	if strings.Contains(output.String(), "PRIVATE") || !strings.Contains(output.String(), "23505") || !strings.Contains(output.String(), "11111111-1111-4111-8111-111111111111") || !strings.Contains(output.String(), "ServiceError") {
		t.Fatal("unsafe/lost diagnostic", output.String())
	}
}
func TestBoundedDiagnosticProjectionAndCurrentSourceFrames(t *testing.T) {
	input := Event{"event": "operations_job_failed", "route": "GET /v1/account/public/11111111-1111-4111-8111-111111111111/posts", "durationMs": 12.3456, "code": "PRIVATE", "body": "PRIVATE", "errorName": "DatabaseError", "errorCode": "23505", "stackFrames": []any{Event{"file": "/opt/galaxy/go/internal/postgres/tx.go", "line": 17, "column": 9}, Event{"file": "https://private.invalid/PRIVATE?token=PRIVATE", "line": 1, "column": 2}}}
	projected := Project(input)
	raw, err := json.Marshal(projected)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "PRIVATE") || projected["route"] != "GET /v1/account/public/:id/posts" || projected["durationMs"] != 12.346 || projected["code"] != "other_error" {
		t.Fatal("unsafe or lost diagnostic", string(raw))
	}
	expected := []any{Event{"file": "go/internal/postgres/tx.go", "line": 17, "column": 9}}
	if !reflect.DeepEqual(projected["stackFrames"], expected) {
		t.Fatal("source frames", projected)
	}
	rejected := Project(Event{"event": "PRIVATE", "state": "PRIVATE", "target": "PRIVATE", "body": "PRIVATE"})
	if !reflect.DeepEqual(rejected, Event{"event": "runtime_event_rejected"}) {
		t.Fatal("unknown diagnostic retained", rejected)
	}
}

func TestDailyRotationOnActualAcceptedWrite(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC).UnixNano())
	dir := t.TempDir()
	logger, e := New(Options{Component: "api", Configuration: Configuration{Directory: dir}, Now: func() time.Time { return time.Unix(0, clock.Load()) }})
	if e != nil {
		t.Fatal(e)
	}
	logger.Write(Event{"event": "runtime_started"})
	deadline := time.Now().Add(time.Second)
	for {
		logger.mu.Lock()
		n := logger.buffered
		logger.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first write not drained")
		}
		time.Sleep(time.Millisecond)
	}
	clock.Add(int64(24 * time.Hour))
	logger.Write(Event{"event": "runtime_stopped"})
	logger.Close()
	if logger.Status().Rotations != 1 {
		t.Fatal("daily rotation missing", logger.Status())
	}
	raw, e := os.ReadFile(filepath.Join(dir, "api-primary", "runtime.1.jsonl.gz"))
	if e != nil {
		t.Fatal(e)
	}
	zip, e := gzip.NewReader(bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	old, _ := io.ReadAll(zip)
	zip.Close()
	current, _ := os.ReadFile(filepath.Join(dir, "api-primary", "runtime.jsonl"))
	if !strings.Contains(string(old), "runtime_started") || !strings.Contains(string(current), "runtime_stopped") {
		t.Fatal("daily boundary changed")
	}
}

func TestRelocatedSDKAndPlatformDiagnosticLocations(t *testing.T) {
	for _, name := range []string{
		"packages/galaxy-client/src/node/connection.mjs",
		"packages/galaxy-contracts/src/verification.mjs",
		"packages/galaxy-official/deploy/maintenance-agent/runtime.mjs",
		"go/internal/native/identity-recovery.go",
	} {
		if got := safeFile("/private/host/" + name); got != name {
			t.Fatalf("current source lost: %s -> %s", name, got)
		}
	}
	for _, name := range []string{"/private/config.json", "packages/galaxy-client/src/../../private.mjs", "https://private.invalid/secret?token=PRIVATE"} {
		if got := safeFile(name); got != "" {
			t.Fatalf("private location retained: %s", got)
		}
	}
}
