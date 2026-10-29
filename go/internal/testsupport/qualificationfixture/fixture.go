// Package qualificationfixture restores one isolated synthetic source dataset.
// The cases, task events and author grants are captured test facts; consumers
// exercise the current Go readers and writers against them.
package qualificationfixture

import (
	"context"
	_ "embed"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
)

//go:embed capture.json
var capture []byte

//go:embed requester.json
var requester []byte

//go:embed contributions.json
var contributions []byte

func New(t *testing.T, pool *pgxpool.Pool, target any) { restore(t, pool, target, capture, false) }
func Publication(t *testing.T, pool *pgxpool.Pool, target any) {
	restore(t, pool, target, requester, false)
}
func SelectedMaterial(t *testing.T, pool *pgxpool.Pool, target any) {
	restore(t, pool, target, contributions, true)
}
func restore(t *testing.T, pool *pgxpool.Pool, target any, source []byte, forum bool) {
	t.Helper()
	if _, err := databaseschema.Migrate(context.Background(), pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	var data struct {
		Fixture json.RawMessage            `json:"fixture"`
		Rows    map[string]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(source, &data); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data.Fixture, target); err != nil {
		t.Fatal(err)
	}
	testsupport.RestoreSyntheticRows(t, pool, data.Rows, "subjects", "binding_challenges", "bindings", "access_credentials", "session_challenges", "community_accounts", "official_account_profiles_v1", "external_identity_links", "community_account_links", "consents", "cases", "case_events", "assistance_requests", "assistance_events")
	if forum {
		var posts []map[string]any
		if err := json.Unmarshal(data.Rows["forum_posts_v1"], &posts); err != nil {
			t.Fatal(err)
		}
		original := map[string]any{}
		for _, post := range posts {
			original[post["id"].(string)] = post["current_version_id"]
			post["current_version_id"] = nil
		}
		raw, err := json.Marshal(posts)
		if err != nil {
			t.Fatal(err)
		}
		data.Rows["forum_posts_v1"] = raw
		testsupport.RestoreSyntheticRows(t, pool, data.Rows, "forum_posts_v1", "forum_events_v1", "forum_permissions_v1", "forum_versions_v1", "forum_daily_usage_v1", "forum_write_receipts_v1")
		for id, version := range original {
			if _, err := pool.Exec(context.Background(), `UPDATE forum_posts_v1 SET current_version_id=$2 WHERE id=$1`, id, version); err != nil {
				t.Fatal(err)
			}
		}
	}
	testsupport.RestoreSyntheticRows(t, pool, data.Rows, "task_requests", "task_participations", "task_events")
	if forum {
		testsupport.RestoreSyntheticRows(t, pool, data.Rows, "task_materials_v1")
	}
	testsupport.RestoreSyntheticRows(t, pool, data.Rows, "audit_events")
}
