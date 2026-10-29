package cases

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
)

type caseFixture struct {
	Endpoint                                                                    string
	Clock                                                                       int64
	Owner                                                                       struct{ Subject, Token string }
	Root, Seed, Attempt, Result, Review, Rollback, Uncreated, NewRoot, NewGrant Object
	Requests                                                                    []Object
	V2root                                                                      Object
	V2events, V2requests                                                        []Object
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
func fixtureValue(t *testing.T, name string) Object {
	t.Helper()
	var out Object
	fixtureJSON(t, name, &out)
	return out
}
func setupCases(t *testing.T, pool *pgxpool.Pool) caseFixture {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Fixture caseFixture                `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	fixtureJSON(t, "setup", &capture)
	testsupport.RestoreSyntheticRows(t, pool, capture.Rows, "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "cases", "case_events", "audit_events")
	return capture.Fixture
}
