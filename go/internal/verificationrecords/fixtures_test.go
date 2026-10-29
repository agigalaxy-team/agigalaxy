package verificationrecords

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
)

type recordFixture struct {
	Endpoint                                                                           string
	Clock                                                                              int64
	Owner, Viewer                                                                      struct{ Subject, Token string }
	Root, First, Second, Verification, GoodCorrection, Intervention, InterventionGrant Object
	Requests                                                                           map[string]Object
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
func setupRecords(t *testing.T, pool *pgxpool.Pool) recordFixture {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	var data struct {
		Fixture recordFixture              `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	fixtureJSON(t, "setup", &data)
	testsupport.RestoreSyntheticRows(t, pool, data.Rows, "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "cases", "case_events", "verification_objects", "verification_events", "audit_events")
	return data.Fixture
}
