package subjectlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOriginalTakeoutSignedDeletionAndDurableResume(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	origin := ""
	node := func(mode string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/subject-lifecycle-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir, "GALAXY_GO_TEST_DEVICE_ORIGIN="+origin)
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("original JS %s: %v %s", mode, e, out)
		}
	}
	node("setup")
	api, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	cfg := api.Config()
	api.Close()
	cfg.ConnConfig.Tracer = queryErrors{t}
	api, e = pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	devices, e := deviceauth.Load(ctx, api, deviceauth.Configuration{Endpoint: "https://device.example.invalid", SigningKeyID: "fixture", SigningKeyFile: filepath.Join(dir, "hub-private.pem"), RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: now})
	if e != nil {
		t.Fatal(e)
	}
	makeService := func() *Service { return &Service{Pool: api, Endpoint: devices.Endpoint, Devices: devices, Now: now} }
	service := makeService()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		Handler{Service: service, Next: deviceauth.Handler{Service: devices}}.ServeHTTP(w, r)
	}))
	defer server.Close()
	origin = server.URL
	node("client")
	raw, _ := os.ReadFile(filepath.Join(dir, "credential.txt"))
	actor, e := devices.Authenticate(ctx, string(raw), "data-export")
	if e != nil {
		t.Fatal(e)
	}
	a := Actor{Actor: actor}
	for _, dataset := range []string{"forum-events", "task-materials", "outcome-materials-v2"} {
		if _, e = service.Create(ctx, a, CreateInput{ID: uuid.NewString(), Datasets: []string{dataset}}); fault.Status(e) != 503 {
			t.Fatalf("missing consumer %s status %v", dataset, e)
		}
	}
	if _, e = service.Create(ctx, a, CreateInput{ID: uuid.NewString()}); fault.Status(e) != 503 {
		t.Fatal("default full-catalog export concealed missing consumer", e)
	}
	var tickets int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM data_exports").Scan(&tickets); e != nil || tickets != 1 {
		t.Fatal("failed create left ticket", tickets, e)
	}
	var saved struct {
		Ticket    struct{ ID string }
		RequestID string
		BindingID string
	}
	raw, _ = os.ReadFile(filepath.Join(dir, "resume.json"))
	_ = json.Unmarshal(raw, &saved)
	// Mutable status is read again; a new service instance resumes the persisted
	// ticket/cursor and the exact original JS reader can use the same ledger.
	service = makeService()
	node("resume")
	node("status")
	if _, e = service.Page(ctx, a, PageInput{ID: saved.Ticket.ID, Dataset: "identity"}); fault.Status(e) != 401 {
		t.Fatal("revoked credential read resumed ticket", e)
	}
	if _, e = service.Execute(ctx, nil); fault.Status(e) != 503 {
		t.Fatal("incomplete executor reported ready", e)
	}
	var bookmarks int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM reading_bookmarks_v1").Scan(&bookmarks); e != nil || bookmarks != 2 {
		t.Fatal("signed request/cancel performed physical erasure", bookmarks, e)
	}
}

type queryErrors struct{ t *testing.T }

func (q queryErrors) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	return ctx
}
func (q queryErrors) TraceQueryEnd(_ context.Context, _ *pgx.Conn, d pgx.TraceQueryEndData) {
	var e *pgconn.PgError
	if errors.As(d.Err, &e) {
		q.t.Logf("database error %s: %s", e.Code, e.Message)
	}
}
