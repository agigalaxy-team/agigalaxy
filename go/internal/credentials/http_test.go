package credentials

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
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

func TestCredentialHTTPOriginalOwnerIntakeAndTransactionRevocation(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "credential-fixture.json")
	setup := fixtureNode(t, dsn, "setup", path, 2000000000)
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var f signedFixture
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
	_, e = owner.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at) SELECT $1,$2,$3,id,issuer,external_subject,true,$4,$5,$6 FROM community_accounts WHERE id=$7`, scope, identity.Digest([]byte(token)), strings.Repeat("3", 64), csrf, now.Unix(), now.Unix()+3600, f.Account.ID)
	if e != nil {
		t.Fatal(e)
	}
	var accountIssuer string
	if e = owner.QueryRow(ctx, `SELECT issuer FROM community_accounts WHERE id=$1`, f.Account.ID).Scan(&accountIssuer); e != nil {
		t.Fatal(e)
	}
	gateway, e := access.New(pool, access.Config{Endpoint: f.Endpoint, WebsiteOrigin: "https://website.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: accountIssuer, OperatorIssuer: "https://operator.example.invalid", AccountScope: scope, OperatorConfiguration: strings.Repeat("2", 64), AdministratorRole: "admin", ReaderRole: "reader"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = func() time.Time { return now }
	portalIdentity := accounts.HTTPIdentityFunc(func(r *http.Request, write bool) (string, accounts.Authorization, error) {
		id, a, e := gateway.Account(r, write)
		return id, a, e
	})
	revokeDuringFetch := false
	fetch := func(_ context.Context, address string) (Object, error) {
		if address != "https://credential-source.example.invalid/status" {
			t.Fatal("credential selected arbitrary network source")
		}
		if revokeDuringFetch {
			_, e := owner.Exec(ctx, `UPDATE official_account_sessions_v1 SET revoked_at=$2 WHERE token_hash=$1`, identity.Digest([]byte(token)), now.Unix())
			if e != nil {
				t.Fatal(e)
			}
		}
		return f.Documents["current"], nil
	}
	service, e := New(f.Endpoint, f.Configuration, func() time.Time { return now }, fetch, nil)
	if e != nil {
		t.Fatal(e)
	}
	handler := Handler{Service: service, Pool: pool, Identity: portalIdentity}
	request := func(method, path string, input any) *http.Request {
		var raw []byte
		if input != nil {
			raw = encoded(t, input)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cookie", "__Host-galaxy-account="+token)
		r.Header.Set("Origin", "https://website.example.invalid")
		r.Header.Set("X-Galaxy-Account-ID", f.Account.ID)
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
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatal("credential privacy headers")
		}
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	owned := call(request("GET", credentialBase+"/"+f.OwnedID, nil), 200)
	if !reflect.DeepEqual(normalized(owned["credential"]), setup["owned"]) {
		t.Fatal("original JS credential HTTP view changed")
	}
	imported := call(request("POST", credentialBase, Object{"credential": f.Tokens["vc2"]}), 201)
	id, ok := imported["id"].(string)
	if !ok {
		t.Fatal("original import receipt missing id")
	}
	replay := call(request("POST", credentialBase, Object{"credential": f.Tokens["vc2"]}), 201)
	if replay["id"] != id {
		t.Fatal("same signed credential lost original ID")
	}
	call(request("POST", credentialBase+"/"+id+"/recheck", Object{}), 200)
	listed := call(request("GET", credentialBase, nil), 200)
	original := fixtureNode(t, dsn, "owner-read", path, 2000000000)
	if !reflect.DeepEqual(normalized(listed), original["list"]) {
		t.Fatal("Go HTTP→original JS credential list differs")
	}
	call(request("GET", credentialBase+"?after="+id, nil), 200)
	for _, query := range []string{"?limit=1", "?after=" + id + "&after=" + id} {
		out := call(request("GET", credentialBase+query, nil), 400)
		if out["error"] != "invalid_external_credential_input" {
			t.Fatal(out)
		}
	}
	call(request("POST", credentialBase, Object{"credential": f.Tokens["vc2"], "extra": true}), 400)
	call(request("POST", credentialBase+"/"+id+"/recheck", Object{"extra": true}), 400)
	call(request("GET", credentialBase+"/"+id+"/recheck", nil), 404)
	call(request("POST", credentialBase+"/"+id, Object{}), 404)
	for _, action := range []struct {
		method, path string
		input        any
	}{{"POST", credentialBase, Object{"credential": f.Tokens["owned"]}}, {"POST", credentialBase + "/" + id + "/recheck", Object{}}, {"DELETE", credentialBase + "/" + id, nil}} {
		r := request(action.method, action.path, action.input)
		r.Header.Del("X-Galaxy-Account-CSRF")
		out := call(r, 403)
		if out["error"] != "account_csrf_invalid" {
			t.Fatal("original write CSRF bypass")
		}
	}
	r := request("GET", credentialBase, nil)
	r.Header.Set("Authorization", "Bearer device-is-not-account-authority")
	call(r, 401)
	r = request("GET", credentialBase, nil)
	r.Header.Del("Cookie")
	call(r, 401)
	r = request("GET", credentialBase, nil)
	r.Header.Set("X-Galaxy-Account-ID", uuid.NewString())
	call(r, 409)
	call(request("DELETE", credentialBase+"/"+id, Object{}), 400)
	r = request("DELETE", credentialBase+"/"+id, nil)
	r.TransferEncoding = []string{"chunked"}
	call(r, 400)
	withdrawn := call(request("DELETE", credentialBase+"/"+id, nil), 200)
	if withdrawn["withdrawn"] != true || withdrawn["issuerRevoked"] != false {
		t.Fatal("withdraw invented issuer revocation")
	}
	call(request("DELETE", credentialBase+"/"+id, nil), 200)
	var retained bool
	if e = owner.QueryRow(ctx, `SELECT credential_jws IS NOT NULL OR metadata ? 'vc' FROM account_external_credentials_v1 WHERE id=$1`, id).Scan(&retained); e != nil || retained {
		t.Fatalf("withdraw retained original material %v", e)
	}
	// Revoke the actual portal session while the controlled issuer-status read is
	// in flight. Final transaction authorization rejects and rolls back import.
	var before, after int
	_ = owner.QueryRow(ctx, `SELECT count(*) FROM account_external_credentials_v1 WHERE account_id=$1`, f.Account.ID).Scan(&before)
	handler.Service, e = New(f.Endpoint, f.Configuration, func() time.Time { return now }, fetch, nil)
	if e != nil {
		t.Fatal(e)
	}
	revokeDuringFetch = true
	call(request("POST", credentialBase, Object{"credential": f.Tokens["external"]}), 401)
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM account_external_credentials_v1 WHERE account_id=$1`, f.Account.ID).Scan(&after); e != nil || after != before {
		t.Fatalf("mid-operation revoked import committed %v", e)
	}
}
