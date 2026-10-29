package profiles_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Captured once from the original implementation using four synthetic IDs and
// a temporary local database. The bearer values are fixed public test markers;
// the original signed envelopes and their exact payloads are retained, while
// private keys are absent. No live identity or service is consulted.
type profileFixture struct {
	Endpoint                                                                                                                 string
	Clock                                                                                                                    int64
	Owner, Viewer, Durable, Legacy                                                                                           actorFixture
	Seed, SeedGrant, SeedReceipt, PrivateStatement, PrivateGrant, Finite, FiniteGrant, StaleGrant, DurableGrant, LegacyGrant Object
}

func fixtureJSON(t *testing.T, name string, value any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, value); err != nil {
		t.Fatal(err)
	}
}
func golden(t *testing.T, name string) Object {
	t.Helper()
	var value Object
	fixtureJSON(t, name, &value)
	return value
}
func setupProfiles(t *testing.T, pool *pgxpool.Pool) profileFixture {
	t.Helper()
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture profileFixture             `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	fixtureJSON(t, "captured-setup", &capture)
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, "subjects", "binding_challenges", "subject_control_heads", "subject_control_events", "device_authorizations", "bindings", "access_credentials", "consents", "profile_statements", "audit_events")
	return capture.Fixture
}
