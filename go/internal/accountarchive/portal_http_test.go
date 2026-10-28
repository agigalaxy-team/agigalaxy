package accountarchive

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPortalArchiveHTTPOriginalRoutesAndCurrentSession(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "archive-fixture.json")
	node(t, dsn, "setup", path, nil)
	raw, _ := os.ReadFile(path)
	var f struct{ Endpoint, Issuer, AccountID string }
	if json.Unmarshal(raw, &f) != nil {
		t.Fatal("fixture")
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := time.Unix(2000000000, 0)
	token, csrf, scope := strings.Repeat("a", 43), strings.Repeat("c", 43), strings.Repeat("1", 64)
	_, e = owner.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at) SELECT $1,$2,$3,id,issuer,external_subject,true,$4,$5,$6 FROM community_accounts WHERE id=$7`, scope, identity.Digest([]byte(token)), strings.Repeat("3", 64), csrf, now.Unix(), now.Unix()+3600, f.AccountID)
	if e != nil {
		t.Fatal(e)
	}
	gateway, e := access.New(pool, access.Config{Endpoint: f.Endpoint, WebsiteOrigin: "https://website.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: f.Issuer, OperatorIssuer: "https://operator.example.invalid", AccountScope: scope, OperatorConfiguration: strings.Repeat("2", 64), AdministratorRole: "admin", ReaderRole: "reader"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = func() time.Time { return now }
	revokeAfterAuthentication := false
	portalIdentity := accounts.HTTPIdentityFunc(func(r *http.Request, write bool) (string, accounts.Authorization, error) {
		id, a, e := gateway.Account(r, write)
		if e == nil && revokeAfterAuthentication {
			_, e = owner.Exec(ctx, `UPDATE official_account_sessions_v1 SET revoked_at=$2 WHERE token_hash=$1`, identity.Digest([]byte(token)), now.Unix())
		}
		return id, a, e
	})
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Now: func() time.Time { return now }}
	handler := Handler{Service: s, Identity: portalIdentity}
	request := func(method, path string, input any) *http.Request {
		r := httptest.NewRequest(method, path, strings.NewReader(string(encoded(input))))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cookie", "__Host-galaxy-account="+token)
		r.Header.Set("Origin", "https://website.example.invalid")
		r.Header.Set("X-Galaxy-Account-ID", f.AccountID)
		r.Header.Set("X-Galaxy-Account-CSRF", csrf)
		return r
	}
	call := func(r *http.Request, want int) Object {
		t.Helper()
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s got %d want %d %s", r.Method, r.URL.Path, w.Code, want, w.Body.String())
		}
		if w.Header().Get("Cache-Control") == "" {
			t.Fatal("private cache header missing")
		}
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	list := call(request("GET", "/v1/account/archives?limit=0x1", nil), 200)
	same(t, list, node(t, dsn, "portal-read", path, nil)["archives"])
	create := Object{"id": uuid.NewString(), "title": "  Portal selected copy  ", "selection": Object{"workspaceId": nil, "sessionIds": []string{"portal-selected"}, "scopeId": uuid.NewString()}, "uploadLevel": "conversation-archive", "includeFullConversation": true}
	id := create["id"].(string)
	call(request("POST", "/v1/account/archives/create", create), 200)
	call(request("POST", "/v1/account/archives/chunk", Object{"id": id, "sequence": 0, "content": "Portal private bytes"}), 200)
	call(request("POST", "/v1/account/archives/complete", Object{"id": id, "chunkCount": 1}), 200)
	for _, action := range []string{"status", "export"} {
		p := Object{"id": id}
		if action == "export" {
			p["sequence"] = 0
		}
		r := request("POST", "/v1/account/archives/"+action, p)
		r.Header.Del("X-Galaxy-Account-CSRF")
		out := call(r, 403)
		if out["error"] != "account_csrf_invalid" {
			t.Fatal("POST read lost original CSRF")
		}
		call(request("POST", "/v1/account/archives/"+action, p), 200)
	}
	exported := call(request("POST", "/v1/account/archives/export", Object{"id": id, "sequence": 0}), 200)
	if exported["content"] != "Portal private bytes" || exported["archive"].(map[string]any)["originSubjectId"] != nil {
		t.Fatal("portal owner origin or content changed")
	}
	call(request("POST", "/v1/account/archives/cleanup", Object{}), 200)
	for _, path := range []string{"/v1/account/archives?limit=1&limit=2", "/v1/account/archives?other=1"} {
		out := call(request("GET", path, nil), 400)
		if out["error"] != "invalid_archive_cursor" {
			t.Fatal(out)
		}
	}
	call(request("POST", "/v1/account/archives/list", Object{}), 404)
	call(request("GET", "/v1/account/archives/status", nil), 404)
	r := request("GET", "/v1/account/archives", nil)
	r.Header.Set("Authorization", "Bearer signed-device-is-not-portal")
	call(r, 401)
	r = request("GET", "/v1/account/archives", nil)
	r.Header.Set("X-Galaxy-Account-ID", uuid.NewString())
	call(r, 409)
	r = request("GET", "/v1/account/archives", nil)
	r.Header.Del("Cookie")
	call(r, 401)
	r = request("GET", "/v1/account/archives?limit=not-a-number", nil)
	r.Header.Del("Cookie")
	call(r, 401)
	call(request("GET", "/v1/account/archives?limit=not-a-number", nil), 400)
	call(request("POST", "/v1/account/archives/delete", Object{"id": id}), 200)
	deleted := call(request("POST", "/v1/account/archives/status", Object{"id": id}), 200)
	if deleted["state"] != "deleted" || deleted["reason"] != "owner-deleted" {
		t.Fatal(deleted)
	}
	revokeAfterAuthentication = true
	create["id"] = uuid.NewString()
	call(request("POST", "/v1/account/archives/create", create), 401)
	var leaked bool
	if e = owner.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM private_conversation_archives_v1 WHERE id=$1)`, create["id"]).Scan(&leaked); e != nil || leaked {
		t.Fatalf("session revoked before tx still wrote %v", e)
	}
}
