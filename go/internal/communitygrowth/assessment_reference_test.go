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
	"github.com/jackc/pgx/v5"
)

func TestAssessmentToolReferenceRoundTripAndOriginalReceipt(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, pool, nil); err != nil {
		t.Fatal(err)
	}
	endpoint := "https://assessment-reference.example.invalid"
	now := func() time.Time { return time.Unix(2000000000, 0) }
	account := publicationfixture.Prepare(t, pool, endpoint, now)["accounts"].([]any)[0].(string)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO community_assessment_config_v1(endpoint,version,enabled,updated_at) VALUES($1,1,true,$2)`, endpoint, now())
	svc := &AssessmentService{Service: &Service{Pool: pool, Endpoint: endpoint, Now: now},
		ReadSourceWithin: func(context.Context, pgx.Tx, AssessmentSource) (Object, error) {
			return Object{"version": "original-version"}, nil
		},
		TaskVersionsWithin: func(context.Context, pgx.Tx, string) (string, string, error) { return "original-model", "1", nil }}
	for index, legacy := range []bool{false, true} {
		domain := []string{"technology", "life"}[index]
		id, sourceID := uuid.NewString(), uuid.NewString()
		keyBytes, _ := json.Marshal([]string{"post", sourceID})
		key := string(keyBytes)
		exec(`INSERT INTO community_assessment_tasks_v1(endpoint,id,account_id,domain,purpose,input_revision,config_version,configuration,native_task_id,created_at,updated_at) VALUES($1,$2,$3,$5,'contribution-impact',1,1,'{}',$2,$4,$4)`, endpoint, id, account, now(), domain)
		exec(`INSERT INTO community_assessment_scopes_v1(endpoint,account_id,domain,purpose,task_id,next_attempt_at,updated_at) VALUES($1,$2,$5,'contribution-impact',$3,$4,$4)`, endpoint, account, id, now(), domain)
		exec(`INSERT INTO community_assessment_materials_v1(endpoint,task_id,source_key,source_kind,source_id,source_revision,snapshot) VALUES($1,$2,$3,'post',$4,1,'{}')`, endpoint, id, key, sourceID)
		page, err := svc.ReadMaterials(ctx, id, "", 20)
		if err != nil {
			t.Fatal(err)
		}
		item := page["items"].([]Object)[0]
		ref := AssessmentEvidence{SourceKey: str(item, "sourceKey"), SourceRevision: 1, SourceVersion: str(item, "sourceVersion")}
		if ref.SourceKey != "post:"+sourceID {
			t.Fatalf("tool exposed internal serialized tuple: %q", ref.SourceKey)
		}
		value := 0.6
		result := AssessmentResult{AccountID: account, Domain: domain, Purpose: "contribution-impact", InputRevision: 1, ConfigVersion: 1, Status: "assessed", Value: &value, Coverage: "partial", Reason: "按所读材料形成参考", Evidence: []AssessmentEvidence{ref}}
		wrong := result
		wrong.Evidence = []AssessmentEvidence{{SourceKey: ref.SourceKey, SourceRevision: 1, SourceVersion: "not-read"}}
		if _, err = svc.SaveResult(ctx, id, wrong); err == nil {
			t.Fatal("reference alias bypassed read version")
		}
		duplicate := result
		duplicate.Evidence = append([]AssessmentEvidence{ref}, AssessmentEvidence{SourceKey: key, SourceRevision: 1, SourceVersion: ref.SourceVersion})
		if _, err = svc.SaveResult(ctx, id, duplicate); err == nil {
			t.Fatal("same material counted twice through two representations")
		}
		if legacy {
			result.Evidence[0].SourceKey = key
		}
		originalRef := result.Evidence[0].SourceKey
		if saved, err := svc.SaveResult(ctx, id, result); err != nil || saved["adopted"] != true {
			t.Fatalf("save: %v %v", saved, err)
		}
		if result.Evidence[0].SourceKey != originalRef {
			t.Fatal("caller request changed while resolving reference")
		}
		if saved, err := svc.SaveResult(ctx, id, result); err != nil || saved["replayed"] != true {
			t.Fatalf("original receipt: %v %v", saved, err)
		}
		var stored string
		if err = pool.QueryRow(ctx, `SELECT evidence->0->>'sourceKey' FROM community_assessment_results_v1 WHERE task_id=$1`, id).Scan(&stored); err != nil || stored != key {
			t.Fatalf("original evidence mapping: %q %v", stored, err)
		}
	}
}
