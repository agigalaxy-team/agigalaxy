package registeredusers_test

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	m "github.com/agigalaxy-team/agigalaxy/go/internal/managementaccounts"
	r "github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type object = map[string]any

func encode(v any) string { b, _ := json.Marshal(v); return string(b) }
func obj(v any) object    { o, _ := v.(map[string]any); return o }
func value(v any) string  { s, _ := v.(string); return s }

type route struct{ origin *url.URL }

func (t route) RoundTrip(req *http.Request) (*http.Response, error) {
	c := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = t.origin.Scheme
	u.Host = t.origin.Host
	c.URL = &u
	return http.DefaultTransport.RoundTrip(c)
}

type roles struct{ native *m.Native }

func (d roles) Roles(ctx context.Context, i, s string) ([]string, error) {
	return d.RolesFresh(ctx, i, s)
}
func (d roles) RolesFresh(ctx context.Context, i, s string) ([]string, error) {
	u, e := d.native.Get(ctx, i, s)
	if e != nil {
		return nil, e
	}
	if u != nil && u.Enabled && u.Admission == "administrator" {
		return []string{"admit-admin"}, nil
	}
	return []string{}, nil
}

type portal struct{ g *access.Gateway }

func (p portal) Summary(ctx context.Context, i, s string) (object, error) {
	v, e := p.g.AccountSessionSummary(ctx, i, s)
	return obj(v), e
}
func (p portal) Revoke(ctx context.Context, i, s string, id *string) (object, error) {
	account := ""
	if id != nil {
		account = *id
	}
	v, e := p.g.RevokeAccountSessions(ctx, account, i, s)
	return obj(v), e
}
func TestRegisteredUsersCurrentHTTPAndOriginalDurableCommands(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	base := registeredFixture(t, admin)
	issuer, management, endpoint := value(base["issuer"]), value(base["management"]), value(base["endpoint"])
	var mu sync.Mutex
	admitted := true
	lost := false
	writes := 0
	users := map[string]object{}
	for _, s := range []string{"formed", "unformed", "machine"} {
		users[s] = object{"id": s, "email": s + "@example.invalid", "emailVerified": true, "enabled": true, "createdTimestamp": 1700000000000, "firstName": "原始", "lastName": s, "requiredActions": []string{"UPDATE_PASSWORD"}, "access": object{"manage": true}}
	}
	users["machine"]["serviceAccountClientId"] = "original-machine"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		path := req.URL.Path
		if strings.HasSuffix(path, "/token") {
			json.NewEncoder(w).Encode(object{"access_token": "isolated-token", "expires_in": 300})
			return
		}
		if strings.Contains(path, "/management/") {
			if strings.HasSuffix(path, "/composite") {
				rows := []any{}
				if admitted {
					rows = append(rows, object{"name": "admit-admin"})
				}
				json.NewEncoder(w).Encode(rows)
			} else {
				json.NewEncoder(w).Encode(object{"id": "root", "username": "root", "enabled": true, "emailVerified": true})
			}
			return
		}
		rest := strings.TrimPrefix(path, "/admin/realms/website/users")
		parts := strings.Split(strings.TrimPrefix(rest, "/"), "/")
		sub := parts[0]
		if req.Method == "GET" {
			switch {
			case rest == "/count":
				json.NewEncoder(w).Encode(len(users))
			case rest == "":
				keys := []string{}
				for k := range users {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				rows := []any{}
				for _, k := range keys {
					rows = append(rows, users[k])
				}
				json.NewEncoder(w).Encode(rows)
			case strings.HasSuffix(path, "/credentials"), strings.HasSuffix(path, "/federated-identity"):
				json.NewEncoder(w).Encode([]any{})
			case strings.HasSuffix(path, "/sessions"):
				json.NewEncoder(w).Encode([]any{object{"id": "not-exposed"}})
			default:
				if u := users[sub]; u != nil {
					json.NewEncoder(w).Encode(u)
				} else {
					w.WriteHeader(404)
				}
			}
			return
		}
		writes++
		if lost {
			lost = false
			c, _, _ := w.(http.Hijacker).Hijack()
			c.Close()
			return
		}
		if strings.HasSuffix(path, "/execute-actions-email") {
			var input []string
			json.NewDecoder(req.Body).Decode(&input)
			if !reflect.DeepEqual(input, []string{"UPDATE_PASSWORD"}) {
				t.Error("password reset changed original intent")
			}
		} else if req.Method == "PUT" {
			var input object
			json.NewDecoder(req.Body).Decode(&input)
			users[sub]["enabled"] = input["enabled"]
		}
		w.WriteHeader(204)
	}))
	defer provider.Close()
	origin, _ := url.Parse(provider.URL)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	native, e := r.NewNative(r.NativeConfig{Issuer: issuer, AdminOrigin: provider.URL, Reader: r.Credential{ClientID: "reader", ClientSecret: "isolated-reader"}, Writer: &r.Credential{ClientID: "writer", ClientSecret: "isolated-writer"}, Now: now, Transport: route{origin}})
	if e != nil {
		t.Fatal(e)
	}
	managementNative, e := m.NewNative(m.NativeConfig{Issuer: management, Reader: m.Credential{ClientID: "reader", ClientSecret: "isolated-reader"}, AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Now: now, Transport: route{origin}})
	if e != nil {
		t.Fatal(e)
	}
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: issuer, OperatorIssuer: management, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{Issuer: management, Subject: "root", OperatorID: value(base["operatorId"])}}, roles{managementNative})
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = now
	service := &r.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Directory: native, Portal: portal{gateway}, Now: now}
	workerCfg, _ := pgxpool.ParseConfig(dsn)
	workerCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	workerPool, e := pgxpool.NewWithConfig(ctx, workerCfg)
	if e != nil {
		t.Fatal(e)
	}
	defer workerPool.Close()
	index := &r.Directory{Pool: workerPool, Endpoint: endpoint, Reader: native, Now: now}
	syncResult, e := index.Sync(ctx)
	if e != nil || syncResult["observedCount"] != int64(2) {
		t.Fatalf("complete directory %v %#v", e, syncResult)
	}
	api := httptest.NewServer(r.Handler{Service: service})
	defer api.Close()
	request := func(method, path string, input object, auth bool) (int, object) {
		t.Helper()
		body := ""
		if input != nil {
			body = encode(input)
		}
		req, _ := http.NewRequest(method, api.URL+"/v1/operations/registered-users"+path, strings.NewReader(body))
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		if auth {
			req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		}
		res, e := api.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		var o object
		if json.Unmarshal(b, &o) != nil {
			t.Fatalf("invalid HTTP JSON %s", b)
		}
		return res.StatusCode, o
	}
	check := func(status int, o object) {
		t.Helper()
		if status != 200 {
			t.Fatalf("HTTP %d %s", status, encode(o))
		}
	}
	equal := func(label string, goValue, jsValue any) {
		t.Helper()
		var a, b any
		json.Unmarshal([]byte(encode(goValue)), &a)
		json.Unmarshal([]byte(encode(jsValue)), &b)
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("%s\nGo%s\nReference%s", label, encode(goValue), encode(jsValue))
		}
	}
	reference := &r.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Directory: native, Portal: portal{gateway}, Now: now}
	referenceActor := func() (r.Actor, error) {
		req := httptest.NewRequest("POST", "https://admin.example.invalid/v1/operations/registered-users", nil)
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		return gateway.AuthorizeOperations(req, true, "")
	}
	read := func(value object, err error) object {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	original := func(mode, id string, input object) object {
		t.Helper()
		actor, err := referenceActor()
		if err != nil {
			t.Fatal(err)
		}
		switch mode {
		case "list":
			if input == nil {
				input = object{}
			}
			return read(reference.List(ctx, actor, input))
		case "source":
			return read(index.Source(ctx, nil))
		case "detail":
			return read(reference.Detail(ctx, actor, id))
		case "command":
			return read(reference.Command(ctx, actor, id, input, referenceActor))
		case "operation":
			return read(reference.Operation(ctx, actor, id))
		default:
			t.Fatal("unexpected current registration view " + mode)
		}
		return nil
	}
	status, o := request("GET", "", nil, false)
	if status != 401 {
		t.Fatalf("anonymous %d %#v", status, o)
	}
	status, o = request("GET", "", nil, true)
	check(status, o)
	equal("complete directory list", o, original("list", "", nil))
	source, e := index.Source(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	equal("published source", source, original("source", "", nil))
	ids := map[string]string{}
	for _, v := range o["items"].([]any) {
		row := obj(v)
		ids[value(obj(row["identity"])["subject"])] = value(row["registrationId"])
	}
	if len(ids) != 3 || ids["machine"] != "" || ids["legacy"] == "" {
		t.Fatalf("registration/business population %#v", ids)
	}
	detail := func(sub string) object {
		status, o := request("GET", "/"+ids[sub], nil, true)
		check(status, o)
		equal("current detail "+sub, o, original("detail", ids[sub], nil))
		return o
	}
	unformed := detail("unformed")
	input := object{"operationId": uuid.NewString(), "kind": "profile-preset", "expectedVersion": unformed["targetVersion"], "expectedPresetRevision": 0, "displayName": "预留🚀", "avatarKey": "book", "bio": " 原简介 ", "basis": "原登记记录", "reason": "更正已登记资料"}
	status, o = request("POST", "/"+ids["unformed"]+"/commands", input, true)
	check(status, o)
	js := original("command", ids["unformed"], input)
	js["replayed"] = o["replayed"]
	equal("preset original replay", o, js)
	detail("unformed")
	var formed int
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM community_accounts WHERE endpoint=$1 AND external_subject='unformed'", endpoint).Scan(&formed); e != nil || formed != 0 {
		t.Fatalf("reserved identity formed business account%d %v", formed, e)
	}
	formedDetail := detail("formed")
	input = object{"operationId": uuid.NewString(), "kind": "profile-correct", "expectedVersion": formedDetail["targetVersion"], "expectedProfileRevision": obj(obj(formedDetail["item"])["business"])["profileRevision"], "displayName": "已形成资料更正", "avatarKey": "leaf", "bio": "原新简介", "basis": "原用户声明", "reason": "更正原资料"}
	status, o = request("POST", "/"+ids["formed"]+"/commands", input, true)
	check(status, o)
	js = original("command", ids["formed"], input)
	js["replayed"] = o["replayed"]
	equal("correction original replay", o, js)
	formedDetail = detail("formed")
	input = object{"operationId": uuid.NewString(), "kind": "login-disable", "expectedVersion": formedDetail["targetVersion"], "reason": "原受控禁用"}
	status, o = request("POST", "/"+ids["formed"]+"/commands", input, true)
	check(status, o)
	if o["state"] != "completed" || obj(obj(obj(o["result"])["effects"])["websiteSessions"])["revokedSessions"] != float64(1) {
		t.Fatalf("distinct SSO/website phases %s", encode(o))
	}
	detail("formed")
	var fences int
	admin.QueryRow(ctx, "SELECT count(*) FROM operations_registered_login_fences_v1 WHERE external_subject='formed'").Scan(&fences)
	if fences != 1 {
		t.Fatal("late-login fence absent")
	}
	before := writes
	status, replay := request("POST", "/"+ids["formed"]+"/commands", input, true)
	check(status, replay)
	if writes != before || replay["replayed"] != true {
		t.Fatal("replayed native intent resent")
	}

	formedDetail = detail("formed")
	restore := object{"operationId": uuid.NewString(), "kind": "login-restore", "expectedVersion": formedDetail["targetVersion"], "reason": "原认证源恢复登录"}
	restored := original("command", ids["formed"], restore)
	if restored["state"] != "completed" {
		t.Fatalf("original restore %s", encode(restored))
	}
	status, o = request("GET", "/operations/"+value(restore["operationId"]), nil, true)
	check(status, o)
	equal("original command consumed by Go", o, original("operation", value(restore["operationId"]), nil))
	formedDetail = detail("formed")
	revoke := object{"operationId": uuid.NewString(), "kind": "sessions-revoke", "expectedVersion": formedDetail["targetVersion"], "reason": "单独撤销原会话"}
	status, o = request("POST", "/"+ids["formed"]+"/commands", revoke, true)
	check(status, o)
	if o["state"] != "completed" {
		t.Fatalf("separate revoke %s", encode(o))
	}
	detail("formed")
	unformed = detail("unformed")
	reset := object{"operationId": uuid.NewString(), "kind": "password-reset", "expectedVersion": unformed["targetVersion"], "reason": "原密码邮件受理"}
	status, o = request("POST", "/"+ids["unformed"]+"/commands", reset, true)
	check(status, o)
	if o["state"] != "submitted" || obj(o["result"])["passwordChanged"] != false {
		t.Fatalf("reset claimed password changed %s", encode(o))
	}
	detail("unformed")
	unformed = detail("unformed")
	input = object{"operationId": uuid.NewString(), "kind": "password-reset", "expectedVersion": unformed["targetVersion"], "reason": "用户请求原密码邮件"}
	mu.Lock()
	lost = true
	mu.Unlock()
	status, o = request("POST", "/"+ids["unformed"]+"/commands", input, true)
	check(status, o)
	if o["state"] != "unknown" {
		t.Fatalf("lost email ACK %s", encode(o))
	}
	before = writes
	status, o = request("POST", "/"+ids["unformed"]+"/commands", input, true)
	check(status, o)
	equal("unknown original receipt", o, original("operation", value(input["operationId"]), nil))
	if writes != before {
		t.Fatal("unknown action-email resent")
	}
	mu.Lock()
	admitted = false
	mu.Unlock()
	status, o = request("GET", "", nil, true)
	if status == 200 {
		t.Fatalf("removed current native admission accepted %#v", o)
	}
}
