package access

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestOriginalPortalCookiesAndCurrentRolesProtectGoFeedback(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts", "go", "feedback-fixture.mjs"), "setup")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("actual schema: %v %s", e, out)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	now := time.Unix(2000000000, 0)
	endpoint, issuer := "https://go-feedback.example.invalid", "https://login.example.invalid/realms/galaxy"
	accountIssuer := "https://accounts.example.invalid/realms/community"
	roles := map[string][]string{"root-subject": {"galaxy-admin"}, "member-subject": {"galaxy-admin"}}
	var tokenCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/realms/galaxy/protocol/openid-connect/token" {
			_ = r.ParseForm()
			if r.Method != "POST" || r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_id") != "fixture-directory" || r.Form.Get("client_secret") != "fixture-only-secret" {
				w.WriteHeader(401)
				return
			}
			tokenCalls.Add(1)
			_, _ = io.WriteString(w, `{"access_token":"fixture-directory-token","expires_in":120}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fixture-directory-token" {
			w.WriteHeader(401)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/admin/realms/galaxy/users/")
		subject := strings.Split(path, "/")[0]
		if strings.HasSuffix(path, "/role-mappings/realm/composite") {
			out := []map[string]string{}
			for _, role := range roles[subject] {
				out = append(out, map[string]string{"name": role})
			}
			_ = json.NewEncoder(w).Encode(out)
			return
		}
		if _, ok := roles[subject]; !ok {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": subject, "enabled": true})
	}))
	defer upstream.Close()
	directory, e := NewKeycloakDirectory(KeycloakConfig{Issuer: issuer, AdminOrigin: upstream.URL, ClientID: "fixture-directory", ClientSecret: "fixture-only-secret"})
	if e != nil {
		t.Fatal(e)
	}
	directory.Now = func() time.Time { return now }
	rootID := identity.Digest([]byte(issuer + "\x00root-subject"))
	memberID := identity.Digest([]byte(issuer + "\x00member-subject"))
	for _, p := range []struct{ id, subject string }{{rootID, "root-subject"}, {memberID, "member-subject"}} {
		_, e = pool.Exec(ctx, `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,'管理账户',$5,$5)`, p.id, endpoint, issuer, p.subject, now)
		if e != nil {
			t.Fatal(e)
		}
	}
	account := uuid.NewString()
	_, e = pool.Exec(ctx, `INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,'person-subject','external-account',$4,$4)`, account, endpoint, accountIssuer, now)
	if e != nil {
		t.Fatal(e)
	}
	_, e = pool.Exec(ctx, "INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,'person','许知遥',$2)", account, now)
	if e != nil {
		t.Fatal(e)
	}
	accountScope, operatorScope := strings.Repeat("1", 64), strings.Repeat("2", 64)
	csrf := strings.Repeat("c", 43)
	tokenAccount, tokenRoot, tokenMember := strings.Repeat("a", 43), strings.Repeat("r", 43), strings.Repeat("m", 43)
	_, e = pool.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at)
	 VALUES($1,$2,$3,$4,$5,'person-subject','person@example.invalid',true,$6,$7,$8)`, accountScope, identity.Digest([]byte(tokenAccount)), strings.Repeat("3", 64), account, accountIssuer, csrf, now.Unix(), now.Unix()+3600)
	if e != nil {
		t.Fatal(e)
	}
	for _, p := range []struct{ id, subject, token string }{{rootID, "root-subject", tokenRoot}, {memberID, "member-subject", tokenMember}} {
		_, e = pool.Exec(ctx, `INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,created_at,expires_at)
		 VALUES($1,$2,$3,$4,$5,$6,'管理账户','administrator',$7,$8,$9)`, endpoint, operatorScope, identity.Digest([]byte(p.token)), p.id, issuer, p.subject, csrf, now, now.Add(time.Hour))
		if e != nil {
			t.Fatal(e)
		}
	}
	g, e := New(pool, Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: accountIssuer, OperatorIssuer: issuer, AccountScope: accountScope, OperatorConfiguration: operatorScope,
		AdministratorRole: "galaxy-admin", ReaderRole: "galaxy-reader", Root: &Root{rootID, issuer, "root-subject"}}, directory)
	if e != nil {
		t.Fatal(e)
	}
	g.Now = func() time.Time { return now }
	s := &feedback.Service{Pool: pool, Endpoint: endpoint, Now: func() time.Time { return now }}
	server := httptest.NewServer(g.SessionHandler(feedback.Handler{Service: s, Identity: g}))
	defer server.Close()
	call := func(method, path, body, kind, token string, extra map[string]string) (int, feedback.Object) {
		t.Helper()
		r, e := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Content-Type", "application/json")
		origin := "https://admin.example.invalid"
		if kind == "account" {
			origin = "https://web.example.invalid"
			r.Header.Set("X-Galaxy-Account-ID", account)
			r.Header.Set("X-Galaxy-Account-CSRF", csrf)
		} else {
			r.Header.Set("X-Galaxy-Operator-CSRF", csrf)
		}
		r.Header.Set("Origin", origin)
		r.Header.Set("Cookie", g.cookie(kind)+"="+token)
		for k, v := range extra {
			r.Header.Set(k, v)
		}
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		var out feedback.Object
		if e = json.NewDecoder(response.Body).Decode(&out); e != nil {
			t.Fatal(e)
		}
		return response.StatusCode, out
	}
	op := uuid.NewString()
	payload := `{"operationId":"` + op + `","body":"从私聊返回后，希望仍保留原来阅读的位置。","module":"chat"}`
	status, out := call("POST", "/v1/account/feedback", payload, "account", tokenAccount, nil)
	if status != 201 {
		t.Fatalf("authenticated Go feedback %d %v", status, out)
	}
	id := out["feedbackId"].(string)
	status, out = call("GET", "/v1/operations/session", "", "operator", tokenRoot, nil)
	if status != 200 || out["state"] != "signed-in" {
		t.Fatalf("session projection %d %v", status, out)
	}
	snapshot := out["operator"].(map[string]any)
	if snapshot["rootAdministrator"] != true || len(snapshot["businessAuthorization"].(map[string]any)["permissions"].([]any)) != len(permissionCodes) {
		t.Fatal("session did not retain root's actual permission catalog")
	}
	status, out = call("GET", "/v1/operations/feedback/"+id, "", "operator", tokenRoot, nil)
	if status != 200 {
		t.Fatalf("root read %d %v", status, out)
	}
	status, out = call("GET", "/v1/operations/feedback/"+id, "", "operator", tokenMember, nil)
	if status != 403 || out["error"] != "operations_permission_denied" {
		t.Fatalf("native admin role granted business rights %d %v", status, out)
	}
	roleID, assignment := uuid.NewString(), uuid.NewString()
	_, e = pool.Exec(ctx, `INSERT INTO operations_business_roles_v1(id,endpoint,name,enabled,version,permissions,created_by,updated_by,created_at,updated_at)
	 VALUES($1,$2,'反馈查看',true,1,ARRAY['feedback.read'],$3,$3,$4,$4)`, roleID, endpoint, rootID, now)
	if e != nil {
		t.Fatal(e)
	}
	_, e = pool.Exec(ctx, `INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at)
	 VALUES($1,$2,$3,$4,true,1,$5,$5,$6,$6)`, assignment, endpoint, memberID, roleID, rootID, now)
	if e != nil {
		t.Fatal(e)
	}
	status, out = call("GET", "/v1/operations/feedback/"+id, "", "operator", tokenMember, nil)
	if status != 200 || out["permissions"].(map[string]any)["canManage"] != false {
		t.Fatalf("assigned role %d %v", status, out)
	}
	update := `{"operationId":"` + uuid.NewString() + `","expectedRevision":1,"state":"processing"}`
	status, _ = call("POST", "/v1/operations/feedback/"+id+"/events", update, "operator", tokenMember, map[string]string{"X-Role": "administrator"})
	if status != 403 {
		t.Fatal("request role bypassed current assignments")
	}
	status, out = call("POST", "/v1/operations/feedback/"+id+"/events", update, "operator", tokenRoot, nil)
	if status != 200 {
		t.Fatalf("root update %d %v", status, out)
	}
	status, _ = call("POST", "/v1/account/feedback", payload, "account", tokenAccount, map[string]string{"X-Galaxy-Account-ID": uuid.NewString()})
	if status != 409 {
		t.Fatal("ambient account changed silently")
	}
	status, _ = call("POST", "/v1/account/feedback", payload, "account", tokenAccount, map[string]string{"X-Galaxy-Account-CSRF": "bad"})
	if status != 403 {
		t.Fatal("missing account CSRF")
	}
	status, _ = call("GET", "/v1/account/feedback/operations/"+op, "", "account", tokenAccount, map[string]string{"Authorization": "Bearer not-a-portal"})
	if status != 401 {
		t.Fatal("bearer mixed with portal")
	}
	// Authentication does not freeze permission: revoke after binding, before query.
	r := httptest.NewRequest("GET", endpoint+"/v1/operations/feedback", nil)
	r.Header.Set("Cookie", g.cookie("operator")+"="+tokenMember)
	r.Header.Set("Origin", g.Config.AdminOrigin)
	person, authority, e := g.Operator(r, false, "feedback.read")
	if e != nil {
		t.Fatal(e)
	}
	_, e = pool.Exec(ctx, "UPDATE operations_role_assignments_v1 SET enabled=false,version=version+1 WHERE id=$1", assignment)
	if e != nil {
		t.Fatal(e)
	}
	boundService := *s
	boundService.Authority = authority
	_, e = boundService.List(ctx, person, feedback.Query{Days: "all"})
	if fault.Code(e) != "operations_permission_denied" {
		t.Fatalf("stale assignment used: %v", e)
	}
	// A temporary authority-service failure must not erase a valid session.
	g.Directory = nil
	status, _ = call("GET", "/v1/operations/feedback/"+id, "", "operator", tokenRoot, nil)
	if status != 503 {
		t.Fatal("temporary authority failure looked signed out")
	}
	var retained int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM operations_operator_sessions_v1 WHERE operator_id=$1", rootID).Scan(&retained); e != nil || retained != 1 {
		t.Fatal("temporary failure deleted the original session")
	}
	g.Directory = directory
	_, e = pool.Exec(ctx, `INSERT INTO operations_management_accounts_v1(operator_id,endpoint,issuer,external_subject,version,login_blocked,created_by,created_at,updated_at)
	 VALUES($1,$2,$3,'member-subject',1,true,$4,$5,$5)`, memberID, endpoint, issuer, rootID, now)
	if e != nil {
		t.Fatal(e)
	}
	status, _ = call("GET", "/v1/operations/feedback/"+id, "", "operator", tokenMember, nil)
	if status != 401 {
		t.Fatal("blocked management identity remained admitted")
	}
	status, out = call("POST", "/v1/operations/logout", "{}", "operator", tokenRoot, nil)
	if status != 200 || out["state"] != "signed-out" {
		t.Fatalf("logout %d %v", status, out)
	}
	status, _ = call("GET", "/v1/operations/feedback/"+id, "", "operator", tokenRoot, nil)
	if status != 401 {
		t.Fatal("revoked portal remained usable")
	}
	if tokenCalls.Load() != 1 {
		t.Fatalf("directory access token not shared, calls=%d", tokenCalls.Load())
	}
}
