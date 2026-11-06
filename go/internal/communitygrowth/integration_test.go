package communitygrowth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fixtureAuthority struct{}

func (fixtureAuthority) Account(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	var exists bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts WHERE endpoint=$1 AND id=$2)`, endpoint, id).Scan(&exists)
	if e != nil {
		return e
	}
	if !exists {
		return fault.New("official_account_login_required", 401)
	}
	return nil
}

// Uses actual community writes and an API-role pool. Only account login is a
// synthetic boundary; public qualification, projections, transactions, events
// and readback are the production implementations.
func TestCommunityGrowthRealWriteCancellationAndPublicQualification(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, owner, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	endpoint := "https://growth.example.invalid"
	now := time.Unix(2000000000, 0)
	profiles := &accounts.Service{Endpoint: endpoint, Now: func() time.Time { return now }}
	ids := []string{}
	for i := 0; i < 2; i++ {
		a, e := postgres.InTx(ctx, owner, func(tx pgx.Tx) (accounts.Account, error) {
			a, e := profiles.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: "https://login.example.invalid", ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: now})
			if e != nil {
				return a, e
			}
			kind := "person"
			_, e = profiles.EnsureProfileWithin(ctx, tx, a.ID, &kind)
			return a, e
		})
		if e != nil {
			t.Fatal(e)
		}
		ids = append(ids, a.ID)
	}
	if _, e := owner.Exec(ctx, `UPDATE official_account_profiles_v1 SET query_enabled=true WHERE account_id=ANY($1::uuid[])`, ids); e != nil {
		t.Fatal(e)
	}
	controls := `{"schema":"business-controls/1","features":{"forumPost":true,"forumReply":true,"chatSend":true,"attachmentUpload":true},"lists":[],"rules":[]}`
	if _, e := owner.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3)`, endpoint, controls, now); e != nil {
		t.Fatal(e)
	}
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	forum := &community.Service{Pool: pool, Endpoint: endpoint, Authority: fixtureAuthority{}, Now: func() time.Time { return now }}
	growth := &Service{Pool: pool, Endpoint: endpoint, Forum: forum, Now: func() time.Time { return now }, PublicAccountWithin: func(ctx context.Context, tx pgx.Tx, _ string, id string) (Object, error) {
		return profiles.PublicProfileWithin(ctx, tx, id, nil)
	}}
	assessment := &AssessmentService{Service: growth}
	growth.OnSourceWithin = assessment.SourceChangedWithin
	forum.OnContentWithin = func(ctx context.Context, tx pgx.Tx, x community.ContentChange) error {
		_, e := growth.ReconcilePublicSourceWithin(ctx, tx, forum, x.Kind, x.ID)
		return e
	}
	forum.OnReactionWithin = func(ctx context.Context, tx pgx.Tx, x community.ReactionChange) error {
		return growth.ReconcileReactionWithin(ctx, tx, forum, x)
	}
	post := Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": ids[0], "postId": uuid.NewString(), "versionId": uuid.NewString(), "expectedHeadVersion": 0, "title": "实际贡献", "body": "可以正常阅读的社区内容。", "links": []any{}, "attachments": []any{}, "topic": "technology", "publishedUntil": now.Add(time.Hour).Unix()}
	community.BindCreatePostIDs(ids[0], post)
	if _, e := forum.Publish(ctx, ids[0], jsonText(post)); e != nil {
		t.Fatal(e)
	}
	postID := str(post, "postId")
	command := Object{"operationId": uuid.NewString(), "kind": "post", "id": postID, "liked": true, "expectedRevision": 0}
	react := func(input Object) Object {
		t.Helper()
		v, e := forum.Reactions(ctx, ids[1], "command", []byte(jsonText(input)))
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	first := react(command)
	replay := react(command)
	if jsonText(first) != jsonText(replay) {
		t.Fatal("same operation changed result")
	}
	get := func() Object {
		t.Helper()
		v, e := growth.PublicOverview(ctx, "", ids[0])
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	if got := get()["experience"]; got != int64(6) {
		t.Fatalf("post and real received like: %v", got)
	}
	if deadline, valid := integer(get()["readExpiresAt"]); !valid || deadline != now.Add(time.Hour).Unix() {
		t.Fatalf("known source deadline was lost: %v", get()["readExpiresAt"])
	}
	contributions, e := growth.PublicContributions(ctx, "", ids[0], 1, "")
	if e != nil {
		t.Fatal(e)
	}
	encoded := jsonText(contributions)
	if strings.Contains(encoded, ids[1]) || strings.Contains(encoded, ReactionSourceID("post", postID, ids[1])) {
		t.Fatal("public contributions disclosed evaluator")
	}
	var count int
	if e := pool.QueryRow(ctx, `SELECT count(*) FROM community_assessment_scopes_v1 WHERE endpoint=$1 AND account_id=$2 AND purpose='contribution-impact'`, endpoint, ids[1]).Scan(&count); e != nil || count != 0 {
		t.Fatalf("giving a like created contribution impact: %d %v", count, e)
	}
	command["operationId"], command["liked"], command["expectedRevision"] = uuid.NewString(), false, 1
	react(command)
	if got := get()["experience"]; got != int64(5) {
		t.Fatalf("cancelled like still counted: %v", got)
	}
	// A qualification change is effective even before background projection.
	if _, e = owner.Exec(ctx, `UPDATE forum_permissions_v1 SET revoked_at=$2 WHERE object_id=$1`, post["versionId"], now); e != nil {
		t.Fatal(e)
	}
	if got := get()["experience"]; got != int64(0) {
		t.Fatalf("revoked content still counted: %v", got)
	}
	if _, e = owner.Exec(ctx, `UPDATE official_account_profiles_v1 SET query_enabled=false WHERE account_id=$1`, ids[0]); e != nil {
		t.Fatal(e)
	}
	h := Handler{Service: growth}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v2/community/growth/accounts/"+ids[0], bytes.NewReader(nil)))
	if w.Code != 404 {
		t.Fatalf("closed public profile returned %d: %s", w.Code, w.Body.String())
	}
	var public Object
	if json.Unmarshal(w.Body.Bytes(), &public) != nil {
		t.Fatal("invalid response")
	}
	if _, exists := public["experience"]; exists {
		t.Fatal("closed profile leaked projection")
	}
	personal, e := growth.OwnerOverview(ctx, ids[0], fixtureAuthority{})
	if e != nil || personal["accountId"] != ids[0] {
		t.Fatalf("owner lost own growth with public profile closed: %v %v", personal, e)
	}
	for _, key := range []string{"weight", "weights", "assessment", "modelVersion", "evidence"} {
		if _, found := personal[key]; found {
			t.Fatalf("owner projection disclosed private assessment field %s", key)
		}
	}
	management := operationsfixture.NewEndpoint(t, owner, endpoint)
	growth.Authority = &operationspermissions.BusinessAuthority{Human: management.Gateway}
	operation := uuid.NewString()
	body := `{"kind":"rule-save","operationId":"` + operation + `","ruleKey":"post","label":"公开帖子","experience":8,"enabled":true,"expectedVersion":1}`
	request := httptest.NewRequest(http.MethodPost, "https://admin.example.invalid/v1/operations/community-growth/command", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	w = httptest.NewRecorder()
	h.ServeHTTP(w, request)
	if w.Code != 200 {
		t.Fatalf("normal management JSON command returned %d: %s", w.Code, w.Body.String())
	}
	var experience, version int64
	if e = pool.QueryRow(ctx, `SELECT experience,version FROM community_growth_rules_v1 WHERE endpoint=$1 AND rule_key='post'`, endpoint).Scan(&experience, &version); e != nil || experience != 8 || version != 2 {
		t.Fatalf("management save not actually adopted: xp=%d revision=%d error=%v", experience, version, e)
	}
	executor := uuid.NewString()
	if _, e = owner.Exec(ctx, `INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,enabled,configuration,prompt_version,plan_version,delegation_version,updated_by,created_at,updated_at) VALUES($1,$2,'discovery',1,false,'{}'::jsonb,1,1,1,$3,$4,$4)`, executor, endpoint, management.Root.ID, now); e != nil {
		t.Fatal(e)
	}
	h.Assessment = assessment
	request = httptest.NewRequest(http.MethodPost, "https://admin.example.invalid/v1/operations/community-growth/assessment-config-command", strings.NewReader(jsonText(Object{
		"kind": "assessment-config-save", "operationId": uuid.NewString(), "expectedVersion": 1, "enabled": true, "executorConfigId": executor,
		"purposes": []string{"contribution-impact", "evaluation-reference"}, "instructions": "依据实际公开材料计算；缺少依据保留未知。",
	})))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	w = httptest.NewRecorder()
	h.ServeHTTP(w, request)
	if w.Code != 200 {
		t.Fatalf("human assessment configuration returned %d: %s", w.Code, w.Body.String())
	}
	var configured bool
	if e = pool.QueryRow(ctx, `SELECT enabled AND executor_config_id=$2 AND version=2 FROM community_assessment_config_v1 WHERE endpoint=$1`, endpoint, executor).Scan(&configured); e != nil || !configured {
		t.Fatalf("human assessment configuration not actually saved: %v %v", configured, e)
	}
}
