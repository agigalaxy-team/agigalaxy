package searchv2

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
func setupSearch(t *testing.T, pool *pgxpool.Pool, domain string, target any) {
	t.Helper()
	roles := []string{"api"}
	if domain == "civ2" {
		roles = append(roles, "worker")
	}
	if _, err := databaseschema.Migrate(context.Background(), pool, roles); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../" + domain + "/testdata/setup.json")
	if err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture json.RawMessage            `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	if err = json.Unmarshal(raw, &capture); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(capture.Fixture, target); err != nil {
		t.Fatal(err)
	}
	tables := []string{"subjects", "binding_challenges", "bindings", "access_credentials", "consents"}
	if domain == "historyv2" {
		tables = append(tables, "audit_events", "cases", "case_events", "profile_statements", "verification_objects", "verification_events")
	} else {
		tables = append(tables, "cases", "case_events", "verification_objects", "verification_events", "jobs", "ci_requests_v2", "ci_observations_v2", "ci_proofs_v2", "audit_events")
	}
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, tables...)
}
