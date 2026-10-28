package access

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
)

type webEventDirectory struct{ unavailable bool }

func (d *webEventDirectory) Roles(context.Context, string, string) ([]string, error) {
	if d.unavailable {
		return nil, errors.New("isolated directory temporarily unavailable")
	}
	return []string{"galaxy-reader"}, nil
}
func (d *webEventDirectory) RolesFresh(ctx context.Context, issuer, subject string) ([]string, error) {
	return d.Roles(ctx, issuer, subject)
}
func TestAdminWebEventAuthorityCurrentPermissionsAndPassiveActivity(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/web-events-interop.mjs"), "setup")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("original schema: %v %s", e, out)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	now := time.Unix(2000000000, 0)
	endpoint, issuer := "https://events.invalid", "https://operator.invalid/realms/admin"
	subject := "event-reader"
	id := identity.Digest([]byte(issuer + "\x00" + subject))
	token, csrf := strings.Repeat("w", 43), strings.Repeat("c", 43)
	hash := identity.Digest([]byte(token))
	scope := strings.Repeat("a", 64)
	role, assignment := uuid.NewString(), uuid.NewString()
	execute := func(sql string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	execute(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,'事件只读', $5,$5)`, id, endpoint, issuer, subject, now)
	execute(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,created_at,expires_at,refresh_cipher,upstream_expires_at,idle_expires_at,max_expires_at) VALUES($1,$2,$3,$4,$5,$6,'事件只读','reader',$7,$8,$9,'fixture-not-decrypted',$10,$11,$12)`, endpoint, scope, hash, id, issuer, subject, csrf, now, now.Add(time.Hour), now.Unix()+3600, now.Unix()+120, now.Unix()+7200)
	execute(`INSERT INTO operations_business_roles_v1(id,endpoint,name,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,'反馈事件查看',true,1,ARRAY['feedback.read'],$3,$3,$4,$4)`, role, endpoint, id, now)
	execute(`INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$3,$3,$5,$5)`, assignment, endpoint, id, role, now)
	directory := &webEventDirectory{}
	g, e := New(pool, Config{Endpoint: endpoint, WebsiteOrigin: "https://web.invalid", AdminOrigin: "https://admin.invalid", AccountIssuer: "https://account.invalid/realms/community", OperatorIssuer: issuer, AccountScope: strings.Repeat("b", 64), OperatorConfiguration: scope, AdministratorRole: "galaxy-admin", ReaderRole: "galaxy-reader"}, directory)
	if e != nil {
		t.Fatal(e)
	}
	now = now.Add(60 * time.Second)
	g.Now = func() time.Time { return now }
	renewal, e := portal.New(pool, "operator", []string{endpoint, scope}, portal.Policy{Key: bytes.Repeat([]byte{1}, 32), IdleSeconds: 3600, MaximumSeconds: 7200, RefreshBeforeSeconds: 30}, nil)
	if e != nil {
		t.Fatal(e)
	}
	renewal.Now = g.Now
	g.OperatorRenewal = renewal
	a := NewWebEventAuthority(g)
	r := httptest.NewRequest("GET", endpoint+"/v1/operations/web-events", nil)
	r.Header.Set("Origin", g.Config.AdminOrigin)
	r.AddCookie(&http.Cookie{Name: g.cookie("operator"), Value: token})
	r.Header.Set("X-Galaxy-Operator-CSRF", csrf)
	r.Header.Set("X-Galaxy-User-Activity", "1")
	p, e := a.AuthorizeConnection(ctx, r, "admin")
	if e != nil {
		t.Fatal(e)
	}
	if r.Header.Get("X-Galaxy-User-Activity") != "1" {
		t.Fatal("adapter mutated original request")
	}
	ok, e := a.AuthorizeModule(ctx, p, "feedback")
	if e != nil || !ok {
		t.Fatalf("assigned feedback permission %v %v", ok, e)
	}
	ok, e = a.AuthorizeModule(ctx, p, "agentos")
	if e != nil || ok {
		t.Fatalf("admitted operator borrowed workbench permission %v %v", ok, e)
	}
	s := &webevents.Service{Pool: pool, Endpoint: endpoint, Authority: a}
	defer s.Stop()
	connection, e := s.Connect(ctx, r, "admin", []string{"feedback"})
	if e != nil {
		t.Fatal(e)
	}
	frames, e := s.Read(ctx, connection, nil)
	if e != nil {
		t.Fatal(e)
	}
	cursor := frames[len(frames)-1].Cursor
	var idle int64
	if e = pool.QueryRow(ctx, "SELECT idle_expires_at FROM operations_operator_sessions_v1 WHERE token_hash=$1", hash).Scan(&idle); e != nil || idle != 2000000120 {
		t.Fatalf("passive heartbeat prolonged idle activity: %d %v", idle, e)
	}
	execute("UPDATE operations_role_assignments_v1 SET enabled=false,version=version+1 WHERE id=$1", assignment)
	ok, e = a.AuthorizeModule(ctx, p, "feedback")
	if e != nil || ok {
		t.Fatalf("revoked permission survived old bound %v %v", ok, e)
	}
	frames, e = s.Read(ctx, connection, &cursor)
	if e != nil || len(frames) < 2 || frames[0].Type != "reset" || len(frames[0].Modules) != 1 || frames[0].Modules[0] != "feedback" {
		t.Fatalf("current role loss did not clear projection: %+v %v", frames, e)
	}
	directory.unavailable = true
	_, e = a.AuthorizeConnection(ctx, r, "admin")
	if fault.Status(e) != 503 {
		t.Fatalf("temporary authority failure reclassified: %v", e)
	}
	_, e = a.AuthorizeModule(ctx, p, "feedback")
	if fault.Status(e) != 503 {
		t.Fatalf("module authority failure reclassified: %v", e)
	}
	var retained int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM operations_operator_sessions_v1 WHERE token_hash=$1", hash).Scan(&retained); e != nil || retained != 1 {
		t.Fatal("temporary failure removed session")
	}
	directory.unavailable = false
	execute("DELETE FROM operations_operator_sessions_v1 WHERE token_hash=$1", hash)
	_, e = a.AuthorizeModule(ctx, p, "feedback")
	if fault.Status(e) != 401 {
		t.Fatalf("expired bound lost status: %v", e)
	}
	_, e = s.Read(ctx, connection, &cursor)
	if fault.Status(e) != 401 {
		t.Fatalf("event service swallowed session loss: %v", e)
	}
	for _, surface := range []string{"device"} {
		_, e = a.AuthorizeConnection(ctx, r, surface)
		if fault.Status(e) != 503 {
			t.Fatalf("unconnected %s domain usable: %v", surface, e)
		}
	}
	publicRequest := httptest.NewRequest("GET", endpoint+"/v1/web-events?topics=account", nil)
	publicRequest.Header.Set("Origin", g.Config.WebsiteOrigin)
	anonymous, e := a.AuthorizeConnection(ctx, publicRequest, "web")
	if e != nil || anonymous.Kind != "anonymous" || anonymous.Identity != "anonymous" {
		t.Fatalf("anonymous event connection: %+v %v", anonymous, e)
	}
	accountID := uuid.NewString()
	accountToken := strings.Repeat("u", 43)
	execute(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,'event-account','external-account',$4,$4)`, accountID, endpoint, g.Config.AccountIssuer, now)
	execute(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$1,$3,$4,'event-account',true,$5,$6,$7)`, g.Config.AccountScope, identity.Digest([]byte(accountToken)), accountID, g.Config.AccountIssuer, csrf, now.Unix(), now.Unix()+3600)
	publicRequest.Header.Set("X-Galaxy-Account-ID", accountID)
	publicRequest.AddCookie(&http.Cookie{Name: "__Host-galaxy-account", Value: accountToken})
	accountPrincipal, e := a.AuthorizeConnection(ctx, publicRequest, "web")
	if e != nil || accountPrincipal.Kind != "official-account" || accountPrincipal.AccountID != accountID {
		t.Fatalf("account event connection: %+v %v", accountPrincipal, e)
	}
	decision, e := a.AuthorizeSource(ctx, accountPrincipal, webevents.Event{Module: "account", SourceTable: "official_account_profiles_v1", Endpoint: endpoint, Ref: map[string]any{"account_id": accountID}})
	if e != nil || decision != webevents.Allowed {
		t.Fatalf("own account event denied: %v %v", decision, e)
	}
	decision, e = a.AuthorizeSource(ctx, accountPrincipal, webevents.Event{Module: "account", SourceTable: "official_account_profiles_v1", Endpoint: endpoint, Ref: map[string]any{"account_id": uuid.NewString()}})
	if e != nil || decision != webevents.Denied {
		t.Fatalf("other account event leaked: %v %v", decision, e)
	}
	publicRequest.Header.Set("Authorization", "Bearer other-device")
	if _, e = a.AuthorizeConnection(ctx, publicRequest, "web"); fault.Status(e) != 503 {
		t.Fatal("device credential fell back to cookie")
	}
	execute("UPDATE official_account_sessions_v1 SET revoked_at=$1 WHERE token_hash=$2", now.Unix(), identity.Digest([]byte(accountToken)))
	decision, e = a.AuthorizeSource(ctx, accountPrincipal, webevents.Event{Module: "account", SourceTable: "official_account_profiles_v1", Endpoint: endpoint, Ref: map[string]any{"account_id": accountID}})
	if e != nil || decision != webevents.Denied {
		t.Fatalf("revoked event authority survived: %v %v", decision, e)
	}
	_, e = a.AuthorizeModule(ctx, webevents.Principal{Surface: "admin", Identity: id, Endpoint: endpoint}, "feedback")
	if fault.Status(e) != 403 {
		t.Fatal("client principal substituted current bound")
	}
}
