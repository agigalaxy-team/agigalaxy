package testsupport

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgreSQL starts in an OS temporary directory on loopback only, with no
// service registration or existing database access. No production DSN is read.
func PostgreSQL(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	bin := os.Getenv("GALAXY_GO_TEST_PG_BIN")
	if bin == "" {
		t.Skip("set GALAXY_GO_TEST_PG_BIN to run isolated PostgreSQL integration")
	}
	if !filepath.IsAbs(bin) {
		t.Fatal("absolute PostgreSQL binary directory required")
	}
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	for _, name := range []string{"initdb", "pg_ctl"} {
		if _, e := os.Stat(filepath.Join(bin, name+ext)); e != nil {
			t.Fatal(e)
		}
	}
	dir := filepath.Join(t.TempDir(), "cluster")
	log := filepath.Join(filepath.Dir(dir), "postgres.log")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if out, e := exec.CommandContext(ctx, filepath.Join(bin, "initdb"+ext), "-D", dir, "-A", "trust", "--no-locale", "-E", "UTF8", "-U", "galaxy_go_test_owner").CombinedOutput(); e != nil {
		t.Fatalf("isolated initdb: %v %s", e, out)
	}
	l, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	// pg_ctl's background server inherits standard handles on Windows. Use a
	// real file rather than a pipe whose EOF would wait for the server to stop.
	controlLog, e := os.Create(filepath.Join(filepath.Dir(dir), "control.log"))
	if e != nil {
		t.Fatal(e)
	}
	defer controlLog.Close()
	start := exec.CommandContext(ctx, filepath.Join(bin, "pg_ctl"+ext), "-D", dir, "-l", log, "-o", fmt.Sprintf("-h 127.0.0.1 -p %d -F", port), "-w", "start")
	start.Stdout = controlLog
	start.Stderr = controlLog
	if e = start.Run(); e != nil {
		t.Fatalf("isolated postgres start: %v", e)
	}
	t.Cleanup(func() {
		c, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		if out, e := exec.CommandContext(c, filepath.Join(bin, "pg_ctl"+ext), "-D", dir, "-m", "fast", "-w", "stop").CombinedOutput(); e != nil {
			t.Errorf("isolated postgres stop: %v %s", e, out)
		}
	})
	adminDSN := fmt.Sprintf("postgres://galaxy_go_test_owner@127.0.0.1:%d/postgres?sslmode=disable", port)
	admin, e := postgres.Open(ctx, adminDSN)
	if e != nil {
		t.Fatal(e)
	}
	_, e = admin.Exec(ctx, "CREATE DATABASE galaxy_go_test_feedback")
	admin.Close()
	if e != nil {
		t.Fatal(e)
	}
	dsn := fmt.Sprintf("postgres://galaxy_go_test_owner@127.0.0.1:%d/galaxy_go_test_feedback?sslmode=disable", port)
	p, e := postgres.Open(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(p.Close)
	return p, dsn
}
