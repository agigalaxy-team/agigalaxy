package discovery

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"path/filepath"
	"testing"
)

// Existing domain captures contain synthetic rows and grants only; restoring them
// lets this integration test exercise the current source and worker roles.
func restoreDomainCapture(t *testing.T, pool *pgxpool.Pool, domain string, tables ...string) Object {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join("..", domain, "testdata", "setup.json"))
	if err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture Object                     `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	if err = json.Unmarshal(raw, &capture); err != nil {
		t.Fatal(err)
	}
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, tables...)
	return capture.Fixture
}
