package accountsocial

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type socialFixture struct {
	Endpoint, Issuer, Owner, Target, Token, Subject                                 string
	Now                                                                             int64
	Targets                                                                         []string
	Posts                                                                           []Reference
	Follow, Save, Personal, LinkedSave, FollowReceipt, SaveReceipt, PersonalReceipt Object
}

func captured(t *testing.T, name string, target any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, target); err != nil {
		t.Fatal(err)
	}
}
func socialGolden(t *testing.T, name string) Object {
	t.Helper()
	var v Object
	captured(t, name, &v)
	return v
}
func setupSocial(t *testing.T, pool *pgxpool.Pool) socialFixture {
	t.Helper()
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, []string{"api"}); err != nil {
		t.Fatal(err)
	}
	var data struct {
		Fixture socialFixture              `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	captured(t, "captured-setup", &data)
	// Posts and versions have a circular FK. Insert posts without the current
	// version, then restore the exact captured head once its version exists.
	var posts []map[string]any
	if err := json.Unmarshal(data.Rows["forum_posts_v1"], &posts); err != nil {
		t.Fatal(err)
	}
	heads := map[string]any{}
	for _, row := range posts {
		heads[row["id"].(string)] = row["current_version_id"]
		row["current_version_id"] = nil
	}
	raw, err := json.Marshal(posts)
	if err != nil {
		t.Fatal(err)
	}
	data.Rows["forum_posts_v1"] = raw
	testsupport.RestoreSyntheticRows(t, pool, data.Rows,
		"subjects", "binding_challenges", "bindings", "access_credentials", "official_account_registrations_v1", "community_accounts", "official_account_profiles_v1", "external_identity_links", "community_account_links", "consents",
		"forum_posts_v1", "forum_events_v1", "forum_permissions_v1", "forum_versions_v1", "forum_daily_usage_v1", "forum_write_receipts_v1",
		"account_follows_v1", "account_follow_operations_v1", "account_reading_bookmarks_v2", "account_reading_bookmark_operations_v2", "reading_bookmarks_v1", "reading_bookmark_operations_v1")
	for id, head := range heads {
		if _, err = pool.Exec(ctx, `UPDATE forum_posts_v1 SET current_version_id=$2 WHERE id=$1`, id, head); err != nil {
			t.Fatal(err)
		}
	}
	return data.Fixture
}

// Database-generated row IDs are not predictable. Bind only those new IDs to
// their target/reference, then check the full original projection and the
// production ordering by timestamp and descending ID.
func compareAfter(t *testing.T, actual, expected, initial Object, kind string) {
	t.Helper()
	got := actual["items"].([]any)
	want := expected["items"].([]any)
	key := func(v any) string {
		row := v.(map[string]any)
		if kind == "follows" {
			return row["relationship"].(map[string]any)["targetAccountId"].(string)
		}
		return row["reference"].(map[string]any)["postId"].(string)
	}
	rowID := func(v any) string {
		row := v.(map[string]any)
		if kind == "follows" {
			return row["relationship"].(map[string]any)["id"].(string)
		}
		return row["id"].(string)
	}
	timestamp := func(v any) string {
		row := v.(map[string]any)
		if kind == "follows" {
			return row["relationship"].(map[string]any)["followedAt"].(string)
		}
		return row["savedAt"].(string)
	}
	initialKeys := map[string]bool{}
	for _, entry := range initial["items"].([]any) {
		initialKeys[key(entry)] = true
	}
	for _, entry := range want {
		if initialKeys[key(entry)] {
			continue
		}
		for _, observed := range got {
			if key(entry) == key(observed) {
				id := rowID(observed)
				if _, err := uuid.Parse(id); err != nil {
					t.Fatal(err)
				}
				if kind == "follows" {
					entry.(map[string]any)["relationship"].(map[string]any)["id"] = id
				} else {
					entry.(map[string]any)["id"] = id
				}
				break
			}
		}
	}
	sort.Slice(want, func(i, j int) bool {
		if timestamp(want[i]) != timestamp(want[j]) {
			return timestamp(want[i]) > timestamp(want[j])
		}
		return rowID(want[i]) > rowID(want[j])
	})
	for i := 1; i < len(got); i++ {
		if timestamp(got[i-1]) < timestamp(got[i]) || (timestamp(got[i-1]) == timestamp(got[i]) && rowID(got[i-1]) < rowID(got[i])) {
			t.Fatal("projection order changed")
		}
	}
	same(t, actual, expected)
}
