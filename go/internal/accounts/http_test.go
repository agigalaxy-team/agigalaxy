package accounts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Explicit isolated identity adapter. Production must use the original portal
// credential verifier; this fixture verifies the HTTP contract and tx boundary.
type httpAccountFixture struct {
	id               string
	checks, rejectAt int
}

func (f *httpAccountFixture) Account(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	f.checks++
	if f.rejectAt > 0 && f.checks >= f.rejectAt {
		return fault.New("official_account_login_required", 401)
	}
	var found bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", id, endpoint).Scan(&found)
	if e != nil {
		return e
	}
	if !found || id != f.id {
		return fault.New("official_account_login_required", 401)
	}
	return nil
}
func (f *httpAccountFixture) Identity(r *http.Request, write bool) (string, Authorization, error) {
	cookie, e := r.Cookie("account-fixture")
	if e != nil || cookie.Value != "verified-fixture-session" {
		return "", nil, fault.New("official_account_login_required", 401)
	}
	if r.Header.Get("Origin") != "https://website.example.invalid" {
		return "", nil, fault.New("account_csrf_invalid", 403)
	}
	if r.Header.Get("X-Galaxy-Account-ID") != f.id {
		return "", nil, fault.New("official_account_changed", 409)
	}
	if write && r.Header.Get("X-Galaxy-Account-CSRF") != "fixture-csrf" {
		return "", nil, fault.New("account_csrf_invalid", 403)
	}
	return f.id, f, nil
}
func TestAccountHTTPOriginalOwnerAndPublicProfileContract(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
	defer cancel()
	initializeAccounts(t, owner)
	pool := apiPool(t, dsn)
	service := &Service{Endpoint: fixtureEndpoint, Now: func() time.Time { return time.Unix(2000000000, 0) }}
	fixture := createTestAccount(t, pool, service, "http-owner")
	account, uid := fixture.ID, fixture.UID
	authority := &httpAccountFixture{id: account}
	handler := Handler{Service: service, Pool: pool, Identity: HTTPIdentityFunc(authority.Identity)}
	request := func(method, path, raw string) *http.Request {
		r := httptest.NewRequest(method, path, strings.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cookie", "account-fixture=verified-fixture-session")
		r.Header.Set("Origin", "https://website.example.invalid")
		r.Header.Set("X-Galaxy-Account-ID", account)
		r.Header.Set("X-Galaxy-Account-CSRF", "fixture-csrf")
		return r
	}
	call := func(r *http.Request) *httptest.ResponseRecorder {
		t.Helper()
		authority.checks = 0
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	errorCode := func(w *httptest.ResponseRecorder) string {
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		value, _ := out["error"].(string)
		return value
	}
	valid := Object{"expectedRevision": 0, "displayName": "HTTP正常资料修改", "publicQuery": Object{"enabled": false, "scope": "profile"}, "archiveRetentionDays": nil}
	raw := string(encode(t, valid))
	for _, tc := range []struct {
		name   string
		modify func(*http.Request)
		status int
		code   string
	}{
		{"cookie", func(r *http.Request) { r.Header.Del("Cookie") }, 401, "official_account_login_required"},
		{"origin", func(r *http.Request) { r.Header.Del("Origin") }, 403, "account_csrf_invalid"},
		{"account-id", func(r *http.Request) { r.Header.Set("X-Galaxy-Account-ID", uuid.NewString()) }, 409, "official_account_changed"},
		{"csrf", func(r *http.Request) { r.Header.Set("X-Galaxy-Account-CSRF", "wrong") }, 403, "account_csrf_invalid"},
		{"authorization", func(r *http.Request) { r.Header.Set("Authorization", "Bearer signed-device-is-not-account") }, 401, "access_denied"},
		{"media", func(r *http.Request) { r.Header.Set("Content-Type", "application/json; charset=utf-8") }, 415, "unsupported_media_type"},
		{"encoding", func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }, 415, "unsupported_media_type"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := request("POST", "/v1/account/settings", raw)
			tc.modify(r)
			w := call(r)
			if w.Code != tc.status || errorCode(w) != tc.code {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
		})
	}
	if w := call(request("GET", "/v1/account/settings?ignored=1", "")); w.Code != 200 || authority.checks != 2 {
		t.Fatalf("original GET ignored query / tx checks %d %s checks=%d", w.Code, w.Body, authority.checks)
	}
	if w := call(request("POST", "/v1/account/settings?unexpected=1", raw)); w.Code != 404 {
		t.Fatalf("write query %d", w.Code)
	}
	for _, tc := range []struct {
		raw, code string
		status    int
	}{{"[]", "invalid_request", 400}, {string([]byte{255}), "invalid_json", 400}, {strings.Repeat("x", 32769), "request_too_large", 413}, {`{"model":"forbidden"}`, "invalid_account_data", 400}} {
		w := call(request("POST", "/v1/account/settings", tc.raw))
		if w.Code != tc.status || errorCode(w) != tc.code {
			t.Fatalf("body contract %d %s", w.Code, w.Body)
		}
	}
	if w := call(request("POST", "/v1/account/settings", raw)); w.Code != 200 {
		t.Fatalf("owner update %d %s", w.Code, w.Body)
	}
	if w := call(request("POST", "/v1/account/settings", raw)); w.Code != 409 {
		t.Fatalf("stale update %d %s", w.Code, w.Body)
	}
	typeBody := Object{"expectedRevision": 1, "subjectType": "organization", "reason": "本人请求更正当前主体类型", "basis": "以本人原始声明作为当前依据", "preserveHistory": true}
	r := request("POST", "/v1/account/type-change", string(encode(t, typeBody)))
	r.Header.Set("X-Operator-ID", "pretend-administrator")
	if w := call(r); w.Code != 200 {
		t.Fatalf("owner type change %d %s", w.Code, w.Body)
	}
	var actor string
	if e := owner.QueryRow(ctx, "SELECT actor_kind FROM official_account_type_history_v1 WHERE account_id=$1 AND revision=2", account).Scan(&actor); e != nil || actor != "account-owner" {
		t.Fatalf("owner request masqueraded as operator %s %v", actor, e)
	}
	// Revocation after the source mutation rolls the entire settings tx back.
	valid["expectedRevision"] = 2
	valid["displayName"] = "MUST_ROLL_BACK"
	valid["publicQuery"] = Object{"enabled": true, "scope": "profile"}
	authority.rejectAt = 2
	w := call(request("POST", "/v1/account/settings", string(encode(t, valid))))
	if w.Code != 401 {
		t.Fatalf("tx revocation %d %s", w.Code, w.Body)
	}
	authority.rejectAt = 0
	var revision int
	var name string
	var enabled bool
	if e := owner.QueryRow(ctx, "SELECT revision,display_name,query_enabled FROM official_account_profiles_v1 WHERE account_id=$1", account).Scan(&revision, &name, &enabled); e != nil || revision != 2 || name != "HTTP正常资料修改" || enabled {
		t.Fatalf("revoked write committed revision=%d name=%s enabled=%v %v", revision, name, enabled, e)
	}
	anonymous := func(path string) *httptest.ResponseRecorder { return call(httptest.NewRequest("GET", path, nil)) }
	if w := anonymous("/v1/account/public/" + account); w.Code != 404 {
		t.Fatalf("private profile exposed %d %s", w.Code, w.Body)
	}
	valid["displayName"] = "明确公开的受控资料"
	valid["publicQuery"] = Object{"enabled": true, "scope": "profile-and-public-posts"}
	if w := call(request("POST", "/v1/account/settings", string(encode(t, valid)))); w.Code != 200 {
		t.Fatalf("explicit public choice %d %s", w.Code, w.Body)
	}
	reference, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return service.PublicProfileWithin(ctx, tx, account, nil) })
	if e != nil {
		t.Fatal(e)
	}
	w = anonymous("/v1/account/public/" + account)
	var public Object
	if e := json.Unmarshal(w.Body.Bytes(), &public); e != nil || w.Code != 200 || !reflect.DeepEqual(public, normalized(t, reference)) {
		t.Fatalf("original public projection differs %d %s / %s %v", w.Code, w.Body, encode(t, reference), e)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" || authority.checks != 0 {
		t.Fatal("public projection acquired account authority or caching")
	}
	if w := anonymous("/v1/account/public/by-uid/" + strings.ToLower(uid)); w.Code != 200 {
		t.Fatalf("UID lookup %d %s", w.Code, w.Body)
	}
	if w := anonymous("/v1/account/public/" + account + "?unexpected=1"); w.Code != 400 {
		t.Fatalf("public query parameters %d", w.Code)
	}
	posts := 0
	handler.PublicPosts = func(_ context.Context, _ pgx.Tx, id string) (any, error) {
		posts++
		if id != account {
			t.Fatal("wrong post owner")
		}
		return Object{"items": []any{}}, nil
	}
	if w := anonymous("/v1/account/public/" + account); w.Code != 200 || posts != 1 {
		t.Fatalf("existing optional public-posts projection %d %s", w.Code, w.Body)
	}
	valid["expectedRevision"] = 3
	valid["publicQuery"] = Object{"enabled": true, "scope": "profile"}
	if w := call(request("POST", "/v1/account/settings", string(encode(t, valid)))); w.Code != 200 {
		t.Fatal(w.Body)
	}
	if w := anonymous("/v1/account/public/" + account); w.Code != 200 || posts != 1 {
		t.Fatalf("profile-only choice invoked posts %d %s", w.Code, w.Body)
	}
	noIdentity := handler
	noIdentity.Identity = nil
	response := httptest.NewRecorder()
	noIdentity.ServeHTTP(response, request("GET", "/v1/account/settings", ""))
	if response.Code != 503 {
		t.Fatalf("missing identity configuration %d", response.Code)
	}
}
