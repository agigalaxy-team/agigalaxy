package evidence

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
)

type evidenceFixture struct {
	Endpoint                                                                                     string
	Clock                                                                                        int64
	Owner                                                                                        struct{ Subject, Token string }
	Root, First, Second, Third, Fourth, ThirdGrant, SeedGrant, SeedProof, NextPreview, NextGrant Object
	SeedID, NextID, RunJSON                                                                      string
	Pins                                                                                         []json.RawMessage
}

func fixtureJSON(t *testing.T, name string, out any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, out); err != nil {
		t.Fatal(err)
	}
}
func fixtureValue(t *testing.T, name string) Object {
	t.Helper()
	var out Object
	fixtureJSON(t, name, &out)
	return out
}
func setupEvidence(t *testing.T, pool *pgxpool.Pool) evidenceFixture {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture evidenceFixture            `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	fixtureJSON(t, "setup", &capture)
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "cases", "case_events", "evidence_submissions", "jobs", "verification_attempts", "proofs", "audit_events")
	return capture.Fixture
}
