package accounts_test

import (
	"context"
	"encoding/json"
	"fmt"
	. "github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
)

func TestPublicAccountOriginalRelationsPagingAndDomainConsumers(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	initializeAccounts(t, pool)
	api := apiPool(t, dsn)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	service := &Service{Endpoint: fixtureEndpoint, Now: now}
	original := seedPublicAccounts(t, pool, api, service)
	accounts := original["accounts"].([]any)
	first := accounts[0].(map[string]any)["id"].(string)
	second := accounts[1].(map[string]any)["id"].(string)
	hidden := accounts[2].(map[string]any)["id"].(string)
	subjects := original["subjects"].([]any)
	subject := subjects[0].(string)
	forum := &community.Service{Pool: api, Endpoint: service.Endpoint, Now: now}
	providers := []Provider{{Issuer: "https://login.example.invalid", ClientID: "configured"}}
	authority := &httpAccountFixture{id: first}
	handler := Handler{Service: service, Pool: api, Identity: HTTPIdentityFunc(authority.Identity), CurrentProviders: func() []Provider { return providers }, PublicPostsPage: func(ctx context.Context, tx pgx.Tx, id string, raw []byte) (Object, error) {
		return forum.PublicForAccountWithin(ctx, tx, id, raw)
	}}
	call := func(path string) (int, Object) {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var out Object
		if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
			t.Fatalf("HTTP %d %s", w.Code, w.Body)
		}
		return w.Code, out
	}
	prefix := "/v1/account/public/"
	status, ids := call(prefix + first + "/ids?limit=1")
	if status != 200 || len(ids["items"].([]any)) != 1 || ids["nextAfter"] == nil {
		t.Fatalf("linked-ID first page: %d %s", status, encode(t, ids))
	}
	status, reverse := call(prefix + "by-id/" + subject + "?limit=1")
	if status != 200 || len(reverse["items"].([]any)) != 1 || reverse["nextAfter"] == nil {
		t.Fatalf("reverse first page: %d %s", status, encode(t, reverse))
	}
	status, next := call(prefix + first + "/ids?limit=1&after=" + ids["nextAfter"].(string))
	if status != 200 || len(next["items"].([]any)) != 1 || next["nextAfter"] != nil {
		t.Fatalf("ID cursor continuation %d %s", status, encode(t, next))
	}
	idSubjects := map[any]bool{ids["items"].([]any)[0].(map[string]any)["subjectId"]: true, next["items"].([]any)[0].(map[string]any)["subjectId"]: true}
	if len(idSubjects) != 2 || !idSubjects[subjects[0]] || !idSubjects[subjects[1]] {
		t.Fatalf("linked-ID page scope: %v", idSubjects)
	}
	status, next = call(prefix + "by-id/" + subject + "?limit=1&after=" + reverse["nextAfter"].(string))
	if status != 200 || len(next["items"].([]any)) != 1 || next["nextAfter"] != nil {
		t.Fatalf("account cursor continuation %d %s", status, encode(t, next))
	}
	accountIDs := map[any]bool{reverse["items"].([]any)[0].(map[string]any)["accountId"]: true, next["items"].([]any)[0].(map[string]any)["accountId"]: true}
	if len(accountIDs) != 2 || !accountIDs[first] || !accountIDs[second] || accountIDs[hidden] {
		t.Fatalf("reverse page scope: %v", accountIDs)
	}
	for _, path := range []string{prefix + first + "/ids?limit=1&limit=2", prefix + first + "/ids?limit=51", prefix + first + "/ids?after=", prefix + "by-id/" + subject + "?after=not-a-uuid", prefix + first + "/posts?after=not-a-post-cursor"} {
		if status, out := call(path); status != 400 || out["error"] != "invalid_account_query" {
			t.Fatalf("invalid page contract %d %s", status, encode(t, out))
		}
	}
	if status, out := call(prefix + first + "/ids?limit=0x1"); status != 200 || len(out["items"].([]any)) != 1 {
		t.Fatalf("original JS numeric conversion %d %s", status, encode(t, out))
	}
	if status, _ := call(prefix + hidden + "/ids"); status != 404 {
		t.Fatal("private account linked IDs exposed")
	}
	providers = nil
	for _, path := range []string{prefix + first + "/ids", prefix + "by-id/" + subject} {
		if status, out := call(path); status != 200 || len(out["items"].([]any)) != 0 {
			t.Fatalf("removed provider retained associations %d %s", status, encode(t, out))
		}
	}
	providers = []Provider{{Issuer: "https://login.example.invalid", ClientID: "configured"}}
	if _, e := pool.Exec(ctx, "UPDATE external_identity_links SET revoked_at=now() WHERE id=$1", original["validFirst"]); e != nil {
		t.Fatal(e)
	}
	status, remaining := call(prefix + first + "/ids")
	if status != 200 || len(remaining["items"].([]any)) != 1 || remaining["items"].([]any)[0].(map[string]any)["subjectId"] != subjects[1] {
		t.Fatalf("revoked link remained %d %s", status, encode(t, remaining))
	}
	status, remaining = call(prefix + "by-id/" + subject)
	if status != 200 || len(remaining["items"].([]any)) != 1 || remaining["items"].([]any)[0].(map[string]any)["accountId"] != second {
		t.Fatalf("reverse revoked association remained %d %s", status, encode(t, remaining))
	}
	if _, e := pool.Exec(ctx, "UPDATE community_account_links SET subject_id=$2 WHERE identity_link_id=$1", original["validSecond"], subjects[2]); e != nil {
		t.Fatal(e)
	}
	if status, out := call(prefix + first + "/ids"); status != 200 || len(out["items"].([]any)) != 0 {
		t.Fatalf("mismatched bidirectional source joined %d %s", status, encode(t, out))
	}
	// Missing credential verification remains unavailable rather than projecting
	// imported SQL metadata as a valid credential. Consumer transport is explicit.
	if status, out := call(prefix + first + "/credentials"); status != 503 || out["error"] != "external_credentials_unavailable" {
		t.Fatalf("missing credential consumer %d %s", status, encode(t, out))
	}
	if status, _ := call(prefix + second + "/credentials"); status != 404 {
		t.Fatal("credential visibility flag bypassed")
	}
	credentialCalls := 0
	handler.PublicCredentialsPage = func(_ context.Context, _ pgx.Tx, id string, raw []byte) (Object, error) {
		credentialCalls++
		var page struct {
			Limit int `json:"limit"`
		}
		if e := json.Unmarshal(raw, &page); e != nil {
			t.Fatal(e)
		}
		if id != first || page.Limit != 1 {
			t.Fatalf("credential consumer page %s %s", id, raw)
		}
		return Object{"accountId": id, "items": []Object{}, "nextAfter": nil, "checkedAt": now().Unix()}, nil
	}
	if status, _ := call(prefix + first + "/credentials?limit=1"); status != 200 || credentialCalls != 1 {
		t.Fatal("qualified credential consumer not called")
	}
	if _, e := pool.Exec(ctx, "UPDATE official_account_profiles_v1 SET query_external_credentials=false WHERE account_id=$1", first); e != nil {
		t.Fatal(e)
	}
	if status, _ := call(prefix + first + "/credentials?limit=1"); status != 404 || credentialCalls != 1 {
		t.Fatal("disabled credentials reached consumer")
	}
	status, posts := call(prefix + first + "/posts?limit=1")
	if status != 200 {
		t.Fatalf("real community consumer %d %s", status, encode(t, posts))
	}
	if status, profile := call(prefix + first); status != 200 || profile["posts"] == nil || len(profile["posts"].(map[string]any)["items"].([]any)) != 2 {
		t.Fatalf("public profile omitted current forum projection %d %s", status, encode(t, profile))
	}
	items := posts["items"].([]any)
	if len(items) != 1 || posts["nextAfter"] == nil {
		t.Fatalf("public post first page: %s", encode(t, posts))
	}
	if status, page := call(prefix + first + "/posts?limit=1&after=" + posts["nextAfter"].(string)); status != 200 || len(page["items"].([]any)) != 1 || page["nextAfter"] != nil {
		t.Fatalf("public post continuation %d %s", status, encode(t, page))
	}
	if status, out := call(prefix + second + "/posts?limit=1&after=" + posts["nextAfter"].(string)); status != 400 || out["error"] != "forum_cursor_mismatch" {
		t.Fatalf("cross-account cursor accepted %d %s", status, encode(t, out))
	}
	handler.PublicPostsPage = nil
	if status, out := call(prefix + first + "/posts"); status != 503 || out["error"] != "forum_unavailable" {
		t.Fatalf("missing posts consumer %d %s", status, encode(t, out))
	}
	if _, e := pool.Exec(ctx, "UPDATE official_account_profiles_v1 SET query_scope='profile' WHERE account_id=$1", first); e != nil {
		t.Fatal(e)
	}
	if status, _ := call(prefix + first + "/posts"); status != 404 {
		t.Fatal("profile-only scope exposed posts")
	}
}

const fixtureEndpoint = "https://accounts.example.invalid"
const fixtureIssuer = "https://login.example.invalid"

func encode(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func initializeAccounts(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, e := databaseschema.Migrate(context.Background(), pool, []string{"api"}); e != nil {
		t.Fatal(e)
	}
}
func apiPool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(context.Background(), cfg)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(pool.Close)
	return pool
}
func createTestAccount(t *testing.T, pool *pgxpool.Pool, service *Service, subject string) Account {
	t.Helper()
	ctx := context.Background()
	account, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Account, error) {
		return service.EnsureAccountWithin(ctx, tx, VerifiedIdentity{Issuer: fixtureIssuer, ExternalSubject: subject, VerificationMethod: "email", VerifiedAt: time.Unix(2000000000, 0)})
	})
	if e != nil {
		t.Fatal(e)
	}
	kind := "person"
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Profile, error) { return service.EnsureProfileWithin(ctx, tx, account.ID, &kind) }); e != nil {
		t.Fatal(e)
	}
	return account
}

type httpAccountFixture struct{ id string }

func (f *httpAccountFixture) Account(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	var found bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)`, id, endpoint).Scan(&found)
	if e != nil {
		return e
	}
	if !found || id != f.id {
		return fault.New("official_account_login_required", 401)
	}
	return nil
}
func (f *httpAccountFixture) Identity(*http.Request, bool) (string, Authorization, error) {
	return f.id, f, nil
}
func seedPublicAccounts(t *testing.T, owner, pool *pgxpool.Pool, service *Service) Object {
	t.Helper()
	ctx := context.Background()
	now := time.Unix(2000000000, 0)
	names := []string{"public-one", "public-two", "private"}
	accounts := []any{}
	for i, name := range names {
		a := createTestAccount(t, pool, service, name)
		accounts = append(accounts, Object{"id": a.ID, "uid": a.UID})
		settings := Object{"expectedRevision": 0, "displayName": name, "archiveRetentionDays": nil, "publicQuery": Object{"enabled": i != 2, "scope": "profile-and-public-posts", "showLinkedIds": true, "showExternalCredentials": i == 0}}
		if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
			return service.UpdateSettingsWithin(ctx, tx, a.ID, encode(t, settings))
		}); e != nil {
			t.Fatal(e)
		}
	}
	subjects := []any{}
	bindings := []string{}
	for i := 1; i <= 3; i++ {
		id := fmt.Sprintf("GUID10%s%d", strings.Repeat("0", 25), i)
		subjects = append(subjects, id)
		challenge, binding := uuid.NewString(), uuid.NewString()
		bindings = append(bindings, binding)
		if _, e := owner.Exec(ctx, `INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,'controlled-relation-fixture','{}')`, id); e != nil {
			t.Fatal(e)
		}
		if _, e := owner.Exec(ctx, `INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at) VALUES($1::uuid,$2,'{}',$1::text,$3)`, challenge, id, now.Add(time.Hour)); e != nil {
			t.Fatal(e)
		}
		if _, e := owner.Exec(ctx, `INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at) VALUES($1,$2,$3,$4,$5,'[]','controlled-no-real-credential',$6)`, binding, id, challenge, strings.Repeat("a", 64), fixtureEndpoint, now.Add(time.Hour)); e != nil {
			t.Fatal(e)
		}
	}
	link := func(accountIndex, subjectIndex int, client, issuer, external, endpoint string, revoked bool) string {
		t.Helper()
		id := uuid.NewString()
		var revokedAt any
		if revoked {
			revokedAt = now
		}
		accountID := accounts[accountIndex].(Object)["id"]
		if _, e := owner.Exec(ctx, `INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature,created_at,revoked_at) VALUES($1,$2,$3,$4,'controlled-provider',$5,$6,$7,'controlled-relation-not-authentication',$8,'controlled-signature',$9,$10)`, id, subjects[subjectIndex], bindings[subjectIndex], endpoint, issuer, external, client, strings.Repeat("b", 64), now, revokedAt); e != nil {
			t.Fatal(e)
		}
		if _, e := owner.Exec(ctx, `INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4)`, id, accountID, subjects[subjectIndex], now); e != nil {
			t.Fatal(e)
		}
		return id
	}
	validFirst := link(0, 0, "configured", fixtureIssuer, names[0], fixtureEndpoint, false)
	validSecond := link(0, 1, "configured", fixtureIssuer, names[0], fixtureEndpoint, false)
	link(1, 0, "configured", fixtureIssuer, names[1], fixtureEndpoint, false)
	link(2, 0, "configured", fixtureIssuer, names[2], fixtureEndpoint, false)
	link(0, 2, "unconfigured", fixtureIssuer, names[0], fixtureEndpoint, false)
	link(0, 2, "configured", "https://other-source.example.invalid", names[0], fixtureEndpoint, false)
	link(0, 2, "configured", fixtureIssuer, "different-account", fixtureEndpoint, false)
	link(0, 2, "configured", fixtureIssuer, names[0], "https://other-endpoint.example.invalid", false)
	link(0, 2, "configured", fixtureIssuer, names[0], fixtureEndpoint, true)
	first := accounts[0].(Object)["id"].(string)
	second := accounts[1].(Object)["id"].(string)
	forum := &community.Service{Pool: pool, Endpoint: fixtureEndpoint, Authority: &httpAccountFixture{id: first}, Rules: fixtureAllowRules{}, Now: func() time.Time { return now }}
	for i := 0; i < 3; i++ {
		post := community.Object{"schemaVersion": 1, "operationId": uuid.NewString(), "accountId": first, "postId": uuid.NewString(), "versionId": uuid.NewString(), "expectedHeadVersion": 0, "title": fmt.Sprintf("controlled public query %d", i), "body": "隔离检查正文，不是用户资料填充。", "links": []any{}, "topic": "technology", "publishedUntil": int64(2000003600)}
		if i == 2 {
			post["audience"] = community.Object{"read": community.Object{"kind": "selected-accounts", "accountIds": []any{second}}, "participate": community.Object{"kind": "accounts"}}
		}
		if !community.BindForumIDs("create-post", first, post) {
			t.Fatal("forum ID derivation")
		}
		if _, e := forum.Publish(ctx, first, string(encode(t, post))); e != nil {
			t.Fatalf("forum seed: %v", e)
		}
	}
	return Object{"accounts": accounts, "subjects": subjects, "validFirst": validFirst, "validSecond": validSecond}
}

// The public-account test isolates source visibility; forum policy is covered by
// the community domain tests and is explicitly replaced for this synthetic seed.
type fixtureAllowRules struct{}

func (fixtureAllowRules) Enforce(context.Context, pgx.Tx, string, string, string, community.Object) error {
	return nil
}
