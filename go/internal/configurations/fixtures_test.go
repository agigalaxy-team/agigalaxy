package configurations

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
func setupConfigurations(t *testing.T, pool *pgxpool.Pool, name string, target any) {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture json.RawMessage            `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	fixtureJSON(t, name, &capture)
	if err := json.Unmarshal(capture.Fixture, target); err != nil {
		t.Fatal(err)
	}
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "audit_events", "cases", "case_events", "configuration_objects", "configuration_events")
}
