package subjectlifecycle

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountarchive"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/hubs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identitygroups"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/targetgovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/watchcontrol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestRetentionWorkerOriginalTaskCopiesHubReceiptsArchiveTombstoneAndRollback(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "execution-fixture.json")
	loadSyntheticExecution(t, pool, path)
	data, _ := os.ReadFile(path)
	var f struct {
		Subject, Other, Endpoint string
		Clock                    int64
		Task, Application        Object
	}
	if e := json.Unmarshal(data, &f); e != nil {
		t.Fatal(e)
	}
	hub, thread, event, account, archive, scope := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	// These rows exercise retention on existing constrained storage. Source
	// authoring/signature authority is independently covered by the owning APIs.
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE task_events SET created_at=$1 WHERE id=$2`, []any{time.Unix(f.Clock-91*86400, 0), f.Application["event"].(map[string]any)["eventId"]}},
		{`INSERT INTO builders(id,owner_id,type)VALUES($1,$2,'hub')`, []any{hub, f.Subject}},
		{`INSERT INTO hub_heads_v2(id,owner_id)VALUES($1,$2)`, []any{hub, f.Subject}},
		{`INSERT INTO hub_intake_v2(id,hub_id,subject_id,version,state,created_at,expires_at)VALUES($1,$2,$3,1,'open',$4,$5)`, []any{thread, hub, f.Subject, f.Clock - 100, f.Clock - 1}},
		{`INSERT INTO hub_events_v2(id,hub_id,subject_id,kind,object_id,object_version,consent_id,payload_text,payload_hash,received_at,intake_id)SELECT $1,$2,$3,'intake-open',$4,1,id,'TEMPORARY-HUB-BODY',repeat('a',64),$5,$4 FROM consents WHERE subject_id=$3 LIMIT 1`, []any{event, hub, f.Subject, thread, f.Clock - 100}},
		{`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)VALUES($1::uuid,$2,'https://issuer.example.invalid',$3,'email',now(),now())`, []any{account, f.Endpoint, account}},
		{`INSERT INTO private_conversation_archives_v1(id,account_id,origin_subject_id,title,selection,created_at,updated_at,expires_at)VALUES($1,$2,$3,'PRIVATE-ARCHIVE',$4::jsonb,now(),now(),$5)`, []any{archive, account, f.Subject, `{"scopeId":"` + scope + `"}`, time.Unix(f.Clock-1, 0)}},
	} {
		if _, e := pool.Exec(ctx, q.sql, q.args...); e != nil {
			t.Fatal(e)
		}
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SET LOCAL ROLE galaxy_evidence_worker"); e != nil {
		t.Fatal(e)
	}
	if _, e = CleanupRetentionWithin(ctx, tx, f.Clock, RetentionConsumers{}); e == nil {
		t.Fatal("missing domain consumers accepted")
	}
	materials := &taskmaterials.Service{Endpoint: f.Endpoint}
	forum := &community.Service{Endpoint: f.Endpoint}
	controls := &watchcontrol.Service{Now: func() time.Time { return time.Unix(f.Clock, 0) }}
	watches := &information.Watches{Now: func() time.Time { return time.Unix(f.Clock, 0) }}
	targets := &targetgovernance.Service{}
	qualificationRequests := &qualification.Service{}
	outcomes := &taskmaterials.OutcomeService{}
	consumers := RetentionConsumers{
		PrivateConversations: accountarchive.CleanupRetentionWithin, IdentityGroups: identitygroups.CleanupWithin,
		Hubs: func(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
			return hubs.CleanupRetentionWithin(ctx, tx, at, func(ctx context.Context, tx pgx.Tx, r hubs.ContentErasure) error {
				return RecordContentErasureWithin(ctx, tx, ContentErasure{Table: r.Table, Key: r.Key, SubjectID: r.SubjectID, OriginalHash: &r.OriginalHash, Reason: r.Reason, At: r.At, RetainedUntil: r.RetainedUntil})
			})
		},
		TaskSnapshots: TaskRedactors{Task: taskmaterials.RedactTaskSnapshot, Participation: taskmaterials.RedactParticipationSnapshot},
		TaskMaterials: materials.CleanupWithin, Forum: forum.CleanupRetentionWithin,
		WatchControls: func(ctx context.Context, tx pgx.Tx, _ int64) (Object, error) {
			return controls.PurgeExpiredWithin(ctx, tx)
		},
		TargetGovernance: targets.CleanupRetentionWithin,
		InformationWatches: func(ctx context.Context, tx pgx.Tx, _ int64) (Object, error) {
			return watches.PurgeExpiredWithin(ctx, tx)
		},
		TaskComments: materials.CleanupCommentsWithin, QualificationRequests: qualificationRequests.CleanupRequestsWithin,
		OutcomeMaterials: func(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
			return outcomes.CleanupWithin(ctx, tx, at, 100)
		},
	}
	result, e := CleanupRetentionWithin(ctx, tx, f.Clock, consumers)
	if e != nil {
		t.Fatal(e)
	}
	removed := result["removed"].(map[string]any)
	snapshots := int(integer(result["snapshotsRedacted"]))
	if integer(removed["temporaryTaskBodies"]) != 1 || snapshots < 1 {
		t.Fatal(removed, snapshots)
	}
	if integer(removed["hubIntakeBodies"]) != 1 || integer(removed["privateConversationArchives"]) != 1 {
		t.Fatal(removed)
	}
	var snapshot string
	if e = tx.QueryRow(ctx, `SELECT snapshot::text FROM task_requests WHERE id=$1`, f.Task["taskId"]).Scan(&snapshot); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(snapshot, "FOREIGN-INDEPENDENT-PROPOSAL") {
		t.Fatal("expired application copied body retained")
	}
	if !strings.Contains(snapshot, "PRIVATE-OWNER-ERASURE") {
		t.Fatal("unexpired task/request scope was erased")
	}
	var receipts int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM lifecycle_erasure_records WHERE object_key IN ($1,$2) AND reason='temporary-content-expired' AND original_payload_hash IS NOT NULL`, event, f.Application["event"].(map[string]any)["eventId"]).Scan(&receipts); e != nil || receipts != 2 {
		t.Fatal(receipts, e)
	}
	if e = tx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	var body string
	if e = pool.QueryRow(ctx, `SELECT payload_text FROM hub_events_v2 WHERE id=$1`, event).Scan(&body); e != nil || body != "TEMPORARY-HUB-BODY" {
		t.Fatal("retention rollback", body, e)
	}
	original := originalProjection(t, "retention")
	committed, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		if _, err := tx.Exec(ctx, "SET LOCAL ROLE galaxy_evidence_worker"); err != nil {
			return nil, err
		}
		return CleanupRetentionWithin(ctx, tx, f.Clock, consumers)
	})
	if e != nil {
		t.Fatal(e)
	}
	executionSame(t, result, original)
	executionSame(t, committed, original)
	var exists bool
	if e = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM private_conversation_deletions_v1 WHERE archive_id=$1 AND scope_id=$2 AND reason='expired')`, archive, scope).Scan(&exists); e != nil || !exists {
		t.Fatal("archive tombstone", e)
	}
}
