package hubs

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"testing"
)

func fixtureJSON(t *testing.T, name string, target any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, target); err != nil {
		t.Fatal(err)
	}
}
func setupHubs(t *testing.T, pool *pgxpool.Pool) Object {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture Object                     `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	fixtureJSON(t, "setup", &capture)
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "audit_events", "builders", "builder_events")
	return capture.Fixture
}
