package access

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
)

func browserOrigin(t *testing.T) string {
	t.Helper()
	l, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	value := "http://" + l.Addr().String()
	_ = l.Close()
	return value
}

// This opt-in check starts the unchanged Next/Payload app against the real Go
// HTTP handler and an isolated second CMS database. It never reads credentials
// or a browser profile from the machine. Ordinary tests do not start Next.
func checkFeedbackBrowser(t *testing.T, g *Gateway, api string, session *http.Cookie, dsn string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	account := uuid.NewString()
	token := strings.Repeat("u", 43)
	csrf := strings.Repeat("c", 43)
	at := time.Now()
	_, e := g.Pool.Exec(ctx, `INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1::uuid,$2,$3,$1::text,'external-account',$4,$4)`, account, g.Config.Endpoint, g.Config.AccountIssuer, at)
	if e != nil {
		t.Fatal(e)
	}
	_, e = g.Pool.Exec(ctx, `INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,'person','林澈',$2)`, account, at)
	if e != nil {
		t.Fatal(e)
	}
	_, e = g.Pool.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$3,$4::uuid,$5,$4::text,'person@example.invalid',true,$6,$7,$8)`, g.Config.AccountScope, identity.Digest([]byte(token)), strings.Repeat("d", 64), account, g.Config.AccountIssuer, csrf, at.Unix(), at.Unix()+3600)
	if e != nil {
		t.Fatal(e)
	}
	r, _ := http.NewRequestWithContext(ctx, "POST", api+"/v1/account/feedback", strings.NewReader(`{"operationId":"`+uuid.NewString()+`","body":"从搜索结果返回后，希望保留原来的分类选择。","module":"discovery"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", g.Config.WebsiteOrigin)
	r.Header.Set("X-Galaxy-Account-ID", account)
	r.Header.Set("X-Galaxy-Account-CSRF", csrf)
	r.AddCookie(&http.Cookie{Name: g.cookie("account"), Value: token})
	response, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != 201 {
		t.Fatalf("real account submit %d %s", response.StatusCode, b)
	}
	var value map[string]any
	if json.Unmarshal(b, &value) != nil {
		t.Fatal("feedback response invalid")
	}
	if _, e = g.Pool.Exec(ctx, "CREATE DATABASE galaxy_go_test_cms"); e != nil {
		t.Fatal(e)
	}
	cms, e := url.Parse(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cms.Path = "/galaxy_go_test_cms"
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts", "go", "feedback-browser.mjs"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_BROWSER_ORIGIN="+g.Config.AdminOrigin, "GALAXY_GO_BROWSER_API="+api, "GALAXY_GO_TEST_CMS_DATABASE_URL="+cms.String(), "GALAXY_GO_BROWSER_OPERATOR_COOKIE="+session.Name+"="+session.Value, "GALAXY_GO_BROWSER_FEEDBACK="+value["feedbackId"].(string))
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("independent headless actual Next/Go path: %v %s", e, out)
	} else {
		t.Log(string(out))
	}
	var state string
	var revision int
	if e = g.Pool.QueryRow(ctx, "SELECT state,revision FROM operations_feedback_v1 WHERE id=$1", value["feedbackId"]).Scan(&state, &revision); e != nil {
		t.Fatal(e)
	}
	if state != "processing" || revision != 2 {
		t.Fatalf("browser save did not reach Go ledger: %s %d", state, revision)
	}
}
