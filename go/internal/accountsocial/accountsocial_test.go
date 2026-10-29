package accountsocial

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func normal(v any) any { var o any; _ = json.Unmarshal(encode(v), &o); return o }
func same(t *testing.T, a, b any) {
	t.Helper()
	if !reflect.DeepEqual(normal(a), normal(b)) {
		t.Fatalf("original projection differs\nGo=%s\nJS=%s", encode(a), encode(b))
	}
}
func expect(t *testing.T, e error, c string) {
	t.Helper()
	if fault.Code(e) != c {
		t.Fatalf("want %s: %v", c, e)
	}
}
func clone(o Object) Object { return normal(o).(map[string]any) }
func TestOriginalSocialLedgersHTTPCurrentSourcesAndLifecycle(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := setupSocial(t, owner)
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := time.Unix(f.Now, 0)
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: func() time.Time { return now }}
	links := &accountlinks.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Providers: []accountlinks.Provider{{Issuer: f.Issuer, ClientID: "galaxy-fixture"}}}
	profiles := &accounts.Service{Endpoint: f.Endpoint, Now: func() time.Time { return now }}
	forum := &community.Service{Pool: pool, Endpoint: f.Endpoint, DeviceAuth: devices, AccountLinks: links, Now: func() time.Time { return now }}
	token, csrf, scope := strings.Repeat("a", 43), strings.Repeat("c", 43), strings.Repeat("1", 64)
	_, e = owner.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at) SELECT $1,$2,$3,id,issuer,external_subject,true,$4,$5,$6 FROM community_accounts WHERE id=$7`, scope, identity.Digest([]byte(token)), strings.Repeat("3", 64), csrf, f.Now, f.Now+3600, f.Owner)
	if e != nil {
		t.Fatal(e)
	}
	gateway, e := access.New(pool, access.Config{Endpoint: f.Endpoint, WebsiteOrigin: "https://website.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: f.Issuer, OperatorIssuer: "https://operator.example.invalid", AccountScope: scope, OperatorConfiguration: strings.Repeat("2", 64), AdministratorRole: "admin", ReaderRole: "reader"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = func() time.Time { return now }
	portalIdentity := accounts.HTTPIdentityFunc(func(r *http.Request, write bool) (string, accounts.Authorization, error) {
		id, a, e := gateway.Account(r, write)
		return id, a, e
	})
	request := func(path string, input any, portal bool) *http.Request {
		r := httptest.NewRequest("POST", path, bytes.NewReader(encode(input)))
		r.Header.Set("Content-Type", "application/json")
		if portal {
			r.Header.Set("Cookie", "__Host-galaxy-account="+token)
			r.Header.Set("Origin", "https://website.example.invalid")
			r.Header.Set("X-Galaxy-Account-ID", f.Owner)
			r.Header.Set("X-Galaxy-Account-CSRF", csrf)
		} else {
			r.Header.Set("Authorization", "Bearer "+f.Token)
		}
		return r
	}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Now: func() time.Time { return now }, Devices: devices, Links: links, Accounts: profiles, Forum: forum}
	pages := 0
	handler := Handler{Service: s, Identity: portalIdentity, Devices: devices, ConsumeSearchPage: func(_ *http.Request, _ Actor, _ any) error { pages++; return nil }}
	call := func(r *http.Request, status int) Object {
		t.Helper()
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s got %d want %d %s", r.Method, r.URL.Path, w.Code, status, w.Body.String())
		}
		var o Object
		_ = json.Unmarshal(w.Body.Bytes(), &o)
		return o
	}
	initial := socialGolden(t, "read-initial")
	original := initial
	same(t, call(request("/v1/account/follows/query", Object{}, true), 200), original["follows"])
	same(t, call(request("/v1/account/bookmarks/query", Object{}, true), 200), original["bookmarks"])
	same(t, call(request("/v2/reading-bookmarks/query", Object{}, false), 200), original["personal"])
	same(t, call(request("/v1/account/follows/command", f.Follow, true), 200), f.FollowReceipt)
	same(t, call(request("/v1/account/bookmarks/command", f.Save, true), 200), f.SaveReceipt)
	same(t, call(request("/v2/reading-bookmarks/command", f.Personal, false), 200), f.PersonalReceipt)
	if pages != 0 {
		t.Fatal("absent pagination position consumed quota")
	}
	for index, target := range f.Targets[1:] {
		cmd := Object{"operationId": uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("social-follow-%d", index))).String(), "targetAccountId": target, "following": true, "expectedRevision": 0}
		call(request("/v1/account/follows/command", cmd, true), 200)
	}
	// New Go mutations are visible to the original JavaScript readers.
	save := Object{"operationId": uuid.NewSHA1(uuid.NameSpaceOID, []byte("social-save-third")).String(), "reference": f.Posts[2], "saved": true, "expectedRevision": 0}
	ack := call(request("/v1/account/bookmarks/command", save, true), 200)
	original = socialGolden(t, "read-after")
	compareAfter(t, call(request("/v1/account/bookmarks/query", Object{}, true), 200), original["bookmarks"].(map[string]any), initial["bookmarks"].(map[string]any), "bookmarks")
	compareAfter(t, call(request("/v1/account/follows/query", Object{}, true), 200), original["follows"].(map[string]any), initial["follows"].(map[string]any), "follows")
	// Same original UUID + hash recovers the committed operation after lost ACK.
	receipt := call(request("/v1/account/bookmarks/receipt", Object{"operationId": save["operationId"], "payloadHash": ack["payloadHash"]}, true), 200)
	same(t, receipt, ack)
	remove := clone(save)
	remove["operationId"] = uuid.NewString()
	remove["saved"] = false
	remove["expectedRevision"] = 1
	call(request("/v1/account/bookmarks/command", remove, true), 200)
	same(t, call(request("/v1/account/bookmarks/command", save, true), 200), ack)
	if call(request("/v1/account/bookmarks/status", Object{"reference": f.Posts[2]}, true), 200)["saved"] != false {
		t.Fatal("late ACK replay revived bookmark")
	}
	conflict := clone(save)
	conflict["saved"] = false
	call(request("/v1/account/bookmarks/command", conflict, true), 409)
	// Account cursor remains bound to owner/filter after its anchor is removed.
	page := call(request("/v1/account/bookmarks/query", Object{"limit": 1}, true), 200)
	cursor := page["nextAfter"].(string)
	anchor := page["items"].([]any)[0].(map[string]any)["id"]
	if _, e = owner.Exec(ctx, `DELETE FROM account_reading_bookmarks_v2 WHERE id=$1`, anchor); e != nil {
		t.Fatal(e)
	}
	call(request("/v1/account/bookmarks/query", Object{"limit": 1, "after": cursor}, true), 200)
	call(request("/v1/account/bookmarks/query", Object{"category": "private-chat", "after": cursor}, true), 409)
	// Closing public query hides the current target projection; cancellation is
	// still allowed, and replay of the old follow command cannot restore it.
	if _, e = owner.Exec(ctx, `UPDATE official_account_profiles_v1 SET query_enabled=false WHERE account_id=$1`, f.Target); e != nil {
		t.Fatal(e)
	}
	page = call(request("/v1/account/follows/query", Object{}, true), 200)
	for _, v := range page["items"].([]any) {
		item := v.(map[string]any)
		if item["relationship"].(map[string]any)["targetAccountId"] == f.Target && item["source"].(map[string]any)["state"] != "unavailable" {
			t.Fatal("closed profile revived")
		}
	}
	unfollow := clone(f.Follow)
	unfollow["operationId"] = uuid.NewString()
	unfollow["following"] = false
	unfollow["expectedRevision"] = 1
	call(request("/v1/account/follows/command", unfollow, true), 200)
	same(t, call(request("/v1/account/follows/command", f.Follow, true), 200), f.FollowReceipt)
	if call(request("/v1/account/follows/status", Object{"targetAccountId": f.Target}, true), 200)["canFollow"] != false {
		t.Fatal("closed target permitted follow")
	}
	// Missing readers cannot claim a first successful save. Existing choices
	// remain removable without granting current source access.
	missing := Object{"operationId": uuid.NewString(), "reference": Reference{Kind: "project", ProjectID: uuid.NewString()}, "saved": true, "expectedRevision": 0}
	call(request("/v1/account/bookmarks/command", missing, true), 503)
	missing["saved"] = false
	call(request("/v1/account/bookmarks/command", missing, true), 200)
	for _, path := range []string{"/v1/account/follows/command", "/v1/account/bookmarks/command"} {
		r := request(path, save, true)
		r.Header.Del("X-Galaxy-Account-CSRF")
		call(r, 403)
	}
	r := request("/v1/account/bookmarks/query", Object{}, true)
	r.Header.Set("Authorization", "Bearer "+f.Token)
	call(r, 401)
	r = request("/v2/account-bookmarks/query", Object{}, false)
	r.Header.Set("X-Galaxy-Account-ID", f.Owner)
	call(r, 200)
	r = request("/v2/account-bookmarks/query", Object{}, false)
	r.Header.Set("X-Galaxy-Account-ID", uuid.NewString())
	call(r, 403)
	call(request("/v1/account/follows/status?unsupported=1", Object{"targetAccountId": f.Target}, true), 404)
	// The original bookmark HTTP dispatcher ignores query strings.
	call(request("/v1/account/bookmarks/status?ignored=1", Object{"reference": f.Posts[0]}, true), 200)
	var events int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM web_event_outbox_v1 WHERE source_table IN ('account_follows_v1','account_reading_bookmarks_v2') AND module IN ('follows','bookmarks')`).Scan(&events); e != nil || events < 2 {
		t.Fatalf("original event capture absent %d %v", events, e)
	}
	// The lifecycle ports export/erase only original ID-owned bookmark rows.
	exported, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) ([]Object, error) {
		return SubjectExportWithin(ctx, tx, f.Subject, "reading-bookmarks", "", now.Add(time.Second), 20)
	})
	if e != nil || len(exported) != 1 {
		t.Fatalf("ID export %v", e)
	}
	if _, e = postgres.InTx(ctx, owner, func(tx pgx.Tx) (Object, error) { return DeleteSubjectWithin(ctx, tx, f.Subject, 20) }); e != nil {
		t.Fatal(e)
	}
	var kept int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM account_reading_bookmarks_v2 WHERE account_id=$1`, f.Owner).Scan(&kept); e != nil || kept == 0 {
		t.Fatal("ID erasure adopted linked account bookmarks")
	}
	// Current provider removal and portal revocation fence cached actors.
	links.Providers = nil
	r = request("/v2/account-bookmarks/query", Object{}, false)
	r.Header.Set("X-Galaxy-Account-ID", f.Owner)
	call(r, 403)
	_, e = owner.Exec(ctx, `UPDATE official_account_sessions_v1 SET revoked_at=$2 WHERE token_hash=$1`, identity.Digest([]byte(token)), f.Now)
	if e != nil {
		t.Fatal(e)
	}
	call(request("/v1/account/follows/query", Object{}, true), 401)
}

func TestOriginalCommandSchemaHashOrder(t *testing.T) {
	var fixture struct {
		Items  []Object `json:"items"`
		Checks []Object `json:"checks"`
	}
	captured(t, "hashes", &fixture)
	variants, expected := fixture.Items, fixture.Checks
	for i, item := range variants {
		follow := item["follow"].(bool)
		p, e := parse(encode(item["value"]), "command", follow, true)
		want := expected[i]
		if (e == nil) != want["accepted"] {
			t.Fatalf("Zod parse mismatch %d", i)
		}
		if e != nil {
			continue
		}
		var value any
		if follow {
			value = followCommand{str(p, "operationId"), str(p, "targetAccountId"), p["following"].(bool), num(p, "expectedRevision")}
		} else {
			r, _ := reference(p["reference"])
			value = bookmarkCommand{str(p, "operationId"), r, p["saved"].(bool), num(p, "expectedRevision")}
		}
		if identity.Digest(encode(value)) != want["hash"] {
			t.Fatalf("original operation hash order differs %d", i)
		}
	}
}
