package builders

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
)

func fixtureJSON(t *testing.T, name string, target any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if err = protocol.Decode(raw, target); err != nil {
		t.Fatal(err)
	}
}
func setupBuilders(t *testing.T, pool *pgxpool.Pool, name string) Object {
	t.Helper()
	roles := []string{"api"}
	if name == "portable-setup" {
		roles = append(roles, "worker")
	}
	if _, err := databaseschema.Migrate(context.Background(), pool, roles); err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture Object                     `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	fixtureJSON(t, name, &capture)
	tables := []string{"subjects", "binding_challenges", "bindings", "access_credentials", "consents", "audit_events"}
	if name == "setup" {
		tables = append(tables, "cases", "case_events", "configuration_objects", "configuration_events")
	} else {
		tables = append(tables, "builders", "builder_events", "jobs")
	}
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, tables...)
	return capture.Fixture
}
