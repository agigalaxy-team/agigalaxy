package communitygrowth

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/google/uuid"
)

func TestAssessmentInvalidationUsesSelectedPromptAndAdoptedDiscoveryModel(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, pool, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	endpoint := "https://assessment-adoption.example.invalid"
	now := func() time.Time { return time.Unix(2000000000, 0) }
	f := publicationfixture.Prepare(t, pool, endpoint, now)
	account := f["accounts"].([]any)[0].(string)
	executor, otherExecutor := uuid.NewString(), uuid.NewString()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, query, args...); e != nil {
			t.Fatal(e)
		}
	}
	for _, entry := range []struct{ id, domain string }{{executor, "discovery"}, {otherExecutor, "messaging"}} {
		exec(`INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,configuration,prompt_version,plan_version,created_at,updated_at) VALUES($1,$2,$3,1,'{}',1,1,$4,$4)`, entry.id, endpoint, entry.domain, now())
	}
	exec(`INSERT INTO community_assessment_config_v1(endpoint,version,executor_config_id,updated_at) VALUES($1,1,$2,$3)`, endpoint, executor, now())
	exec(`INSERT INTO community_assessment_scopes_v1(endpoint,account_id,domain,purpose,next_attempt_at,updated_at) VALUES($1,$2,'technology','contribution-impact',$3,$3)`, endpoint, account, now())
	check := func(want int64) {
		t.Helper()
		var revision int64
		if e := pool.QueryRow(ctx, `SELECT input_revision FROM community_assessment_scopes_v1 WHERE endpoint=$1 AND account_id=$2`, endpoint, account).Scan(&revision); e != nil || revision != want {
			t.Fatalf("input revision=%d want=%d error=%v", revision, want, e)
		}
	}
	exec(`UPDATE operations_autonomy_configs_v1 SET prompt_version=prompt_version+1 WHERE id=$1`, otherExecutor)
	check(1)
	exec(`UPDATE operations_autonomy_configs_v1 SET prompt_version=prompt_version+1 WHERE id=$1`, executor)
	check(2)
	// The technical model material includes both selected execution settings
	// and selected fallbacks. Unrelated scene/model edits remain unrelated.
	configuration := Object{"scenarios": Object{"discovery": Object{"modelId": "primary", "dataPolicyApproved": true}, "messaging": Object{"modelId": "other", "dataPolicyApproved": true}},
		"models": []Object{{"id": "primary", "modelId": "native-model", "displayName": "Primary", "fallbacks": []Object{{"modelId": "backup", "dataPolicyApproved": true}}}, {"id": "backup", "timeoutSeconds": 60}, {"id": "other", "timeoutSeconds": 60}}}
	version := func(number int, value Object) string {
		t.Helper()
		id := uuid.NewString()
		exec(`INSERT INTO operations_model_settings_versions_v1(id,endpoint,version,configuration,operator_id,created_at) VALUES($1,$2,$3,$4,'test-owner',$5)`, id, endpoint, number, jsonText(value), now())
		return id
	}
	copyConfiguration := func(value Object) Object {
		var out Object
		if e := json.Unmarshal([]byte(jsonText(value)), &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	first := version(1, configuration)
	exec(`INSERT INTO operations_model_settings_state_v1(endpoint,active_id,updated_at) VALUES($1,$2,$3)`, endpoint, first, now())
	changed := copyConfiguration(configuration)
	changed["models"].([]any)[0].(map[string]any)["displayName"] = "Renamed"
	changed["models"].([]any)[2].(map[string]any)["timeoutSeconds"] = 90
	unrelated := version(2, changed)
	exec(`UPDATE operations_model_settings_state_v1 SET draft_id=$2 WHERE endpoint=$1`, endpoint, unrelated)
	check(2)
	exec(`UPDATE operations_model_settings_state_v1 SET active_id=$2 WHERE endpoint=$1`, endpoint, unrelated)
	check(2)
	changed["models"].([]any)[1].(map[string]any)["timeoutSeconds"] = 120
	backupChanged := version(3, changed)
	exec(`UPDATE operations_model_settings_state_v1 SET draft_id=$2 WHERE endpoint=$1`, endpoint, backupChanged)
	check(2)
	exec(`UPDATE operations_model_settings_state_v1 SET active_id=$2 WHERE endpoint=$1`, endpoint, backupChanged)
	check(3)
}
