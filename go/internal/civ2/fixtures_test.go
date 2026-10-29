package civ2

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ciFixture struct {
	Endpoint                                                                                                                     string
	Clock                                                                                                                        int64
	Owner                                                                                                                        struct{ Subject, Token string }
	Root, OtherRoot, Evidence, OtherEvidence, First, Second, SecondGrant, Third, ThirdGrant, NextPreview, NextGrant, RevokeGrant Object
	SeedID, NextID, RunJSON                                                                                                      string
	Pins                                                                                                                         []json.RawMessage
}

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
func setupCI(t *testing.T, pool *pgxpool.Pool) ciFixture {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture ciFixture                  `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	fixtureJSON(t, "setup", &capture)
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "cases", "case_events", "verification_objects", "verification_events", "jobs", "ci_requests_v2", "ci_observations_v2", "ci_proofs_v2", "audit_events")
	return capture.Fixture
}
