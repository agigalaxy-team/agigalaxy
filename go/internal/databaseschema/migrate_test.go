package databaseschema

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

func TestOriginalSchemaFreshUpgradeAndExistingHistory(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	versions := Versions()
	version, err := Migrate(ctx, pool, nil)
	if err != nil {
		t.Fatal(err)
	}
	if version != versions[len(versions)-1] {
		t.Fatalf("unexpected current version %d", version)
	}
	var count int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != len(versions) {
		t.Fatalf("original migration history: count=%d error=%v", count, err)
	}
	// A rerun must consume the existing ledger, not rebuild the schema.
	if _, err = Migrate(ctx, pool, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "DELETE FROM schema_migrations WHERE version=$1", versions[0]); err != nil {
		t.Fatal(err)
	}
	if _, err = Migrate(ctx, pool, nil); err == nil {
		t.Fatal("a missing applied prefix must not be silently replayed")
	}
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != len(versions)-1 {
		t.Fatalf("rejected upgrade changed history: count=%d error=%v", count, err)
	}
	if _, err = pool.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES($1)", versions[len(versions)-1]+1); err != nil {
		t.Fatal(err)
	}
	if _, err = Migrate(ctx, pool, nil); err == nil {
		t.Fatal("a newer schema must not be accepted")
	}
}
