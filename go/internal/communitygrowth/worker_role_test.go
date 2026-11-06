package communitygrowth

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/publicationfixture"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestHistoricalGrowthRunsWithActualWorkerRole(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, owner, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	endpoint := "https://growth-worker.example.invalid"
	now := func() time.Time { return time.Unix(2000000000, 0) }
	f := publicationfixture.Prepare(t, owner, endpoint, now)
	account := f["accounts"].([]any)[0].(string)
	forum := &community.Service{Pool: owner, Endpoint: endpoint, Authority: fixtureAuthority{}, Now: now}
	payload := f["payload"].(map[string]any)
	if _, err := forum.Publish(ctx, account, jsonText(payload)); err != nil {
		t.Fatal(err)
	}
	// Publication intentionally has no growth hook: this is an existing record.
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	reader := &community.Service{Pool: pool, Endpoint: endpoint, Now: now}
	svc := &Service{Pool: pool, Endpoint: endpoint, Forum: reader, WorkerPublicRead: true, Now: now}
	worker := &Worker{Service: svc, Forum: reader}
	for cycle := 0; cycle < 2; cycle++ {
		for {
			result, err := worker.Step(ctx)
			if err != nil {
				t.Fatal("actual worker failed to adopt historical content", err)
			}
			if result["cycleComplete"] == true {
				break
			}
		}
		var count int
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM community_growth_sources_v1 WHERE endpoint=$1 AND source_kind='post' AND source_id=$2 AND account_id=$3 AND active`, endpoint, payload["postId"], account).Scan(&count); err != nil || count != 1 {
			t.Fatalf("historical source count=%d error=%v", count, err)
		}
	}
	var mayEditState bool
	if err := pool.QueryRow(ctx, `SELECT has_column_privilege(current_user,'forum_posts_v1','state','UPDATE')`).Scan(&mayEditState); err != nil || mayEditState {
		t.Fatalf("projection worker gained content editing privilege: %v %v", mayEditState, err)
	}
}
