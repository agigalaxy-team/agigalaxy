package credentials

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Captured from the original implementation in an isolated database. These
// credentials, public keys and status documents are synthetic test vectors;
// the generating private keys and any live account data are not included.
func captureJSON(t *testing.T, name string, target any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, target); err != nil {
		t.Fatal(err)
	}
}
func credentialGolden(t *testing.T, name string) Object {
	t.Helper()
	var result Object
	captureJSON(t, name, &result)
	return result
}
func setupCredentials(t *testing.T, pool *pgxpool.Pool, name string) (signedFixture, Object) {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Fixture signedFixture              `json:"fixture"`
		Result  Object                     `json:"result"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	captureJSON(t, name, &fixture)
	testsupport.RestoreSyntheticRows(t, pool, fixture.Rows, "official_account_registrations_v1", "community_accounts", "official_account_profiles_v1", "account_external_credentials_v1")
	return fixture.Fixture, fixture.Result
}

// Subsequent imports generate new local row IDs. Bind those IDs by the signed
// credential ID while preserving the captured original ID and all other fields.
// Also check the complete API ordering rather than hiding it through sorting.
func compareCredentialProjection(t *testing.T, actual, expected Object, ownedID string, public bool) {
	t.Helper()
	got := normalized(actual).(map[string]any)
	want := normalized(expected).(map[string]any)
	gotItems := got["items"].([]any)
	wantItems := want["items"].([]any)
	key := func(v any) string { return v.(map[string]any)["source"].(map[string]any)["credentialId"].(string) }
	id := func(v any) string { return v.(map[string]any)["id"].(string) }
	imported := func(v any) string { return v.(map[string]any)["importedAt"].(string) }
	for _, entry := range wantItems {
		if id(entry) == ownedID {
			continue
		}
		for _, observed := range gotItems {
			if key(entry) == key(observed) {
				value := id(observed)
				if _, err := uuid.Parse(value); err != nil {
					t.Fatal(err)
				}
				entry.(map[string]any)["id"] = value
				break
			}
		}
	}
	before := func(a, b any) bool {
		if public {
			return id(a) < id(b)
		}
		if imported(a) != imported(b) {
			return imported(a) > imported(b)
		}
		return id(a) > id(b)
	}
	sort.Slice(wantItems, func(i, j int) bool { return before(wantItems[i], wantItems[j]) })
	for i := 1; i < len(gotItems); i++ {
		if !before(gotItems[i-1], gotItems[i]) {
			t.Fatal("credential ordering changed")
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("credential projection differs from original: got=%s want=%s", encoded(t, got), encoded(t, want))
	}
}
