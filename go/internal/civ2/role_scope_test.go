package civ2

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"path/filepath"
	"testing"
)

// The role supply source, not a history migration, now names the original
// request/case arguments by position. Exercise that exact scoped SQL directly.
func TestOriginalCIWorkerRoleRequestScope(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	public, _, _ := ed25519.GenerateKey(rand.Reader)
	pem, _ := identity.PublicPEM(public)
	path := filepath.Join(t.TempDir(), "ci-fixture.json")
	node(t, dsn, "setup", path, Object{"publicKey": pem})
	raw, _ := os.ReadFile(path)
	var f struct{ Root, OtherRoot, Evidence, OtherEvidence, First Object }
	if e := json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		for _, q := range []struct {
			function, id string
			allow        bool
		}{{"galaxy_worker_lock_ci_case", str(f.Root, "caseId"), true}, {"galaxy_worker_lock_ci_case", str(f.OtherRoot, "caseId"), false}, {"galaxy_worker_lock_ci_record", str(f.Evidence, "id"), true}, {"galaxy_worker_lock_ci_record", str(f.OtherEvidence, "id"), false}} {
			var got string
			e := tx.QueryRow(ctx, "SELECT id::text FROM public."+q.function+"($1,$2)", f.First["id"], q.id).Scan(&got)
			if q.allow {
				if e != nil || got != q.id {
					t.Fatalf("valid signed-request source rejected %s %s %v", q.function, got, e)
				}
			} else if !errors.Is(e, pgx.ErrNoRows) {
				t.Fatalf("foreign source escaped bound request %s %s %v", q.function, got, e)
			}
		}
		return nil, nil
	})
	if e != nil {
		t.Fatal(e)
	}
}
