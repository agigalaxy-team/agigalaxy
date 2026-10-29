package webevents_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
)

func TestRealPublicPortalAndControlledDeviceSubscriptions(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	origin := ""
	node := func(mode string) []byte {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/device-client-fixture.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir, "GALAXY_GO_TEST_DEVICE_ORIGIN="+origin)
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original device interop %s: %v %s", mode, e, out)
		}
		return out
	}
	deviceauthfixture.Prepare(t, pool, dir, []string{"binding", "history"})
	api, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	at := int64(2000000000)
	endpoint := "https://device.example.invalid"
	device, e := deviceauth.Load(ctx, api, deviceauth.Configuration{Endpoint: endpoint, SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(at, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	handshake := httptest.NewServer(deviceauth.Handler{Service: device})
	defer handshake.Close()
	origin = handshake.URL
	node("client")
	tokenBytes, e := os.ReadFile(filepath.Join(dir, "credential.txt"))
	if e != nil {
		t.Fatal(e)
	}
	deviceToken := string(tokenBytes)
	scope, portalToken, csrf := strings.Repeat("a", 64), strings.Repeat("p", 43), strings.Repeat("c", 43)
	accountIssuer := "https://account.invalid/realms/community"
	account, other := uuid.NewString(), uuid.NewString()
	execute := func(sql string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	for _, id := range []string{account, other} {
		execute(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1::uuid,$2,$3,$1::text,'external-account',$4,$4)`, id, endpoint, accountIssuer, time.Unix(at, 0))
		execute(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,'person','PRIVATE_PROFILE_BODY',$2)`, id, time.Unix(at, 0))
	}
	execute(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$3,$4::uuid,$5,$4::text,'synthetic@example.invalid',true,$6,$7,$8)`, scope, identity.Digest([]byte(portalToken)), strings.Repeat("b", 64), account, accountIssuer, csrf, at, at+3600)
	gateway, e := access.New(api, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://website.invalid", AdminOrigin: "https://admin.invalid", AccountIssuer: accountIssuer, OperatorIssuer: "https://operator.invalid/realms/admin", AccountScope: scope, OperatorConfiguration: strings.Repeat("d", 64), AdministratorRole: "galaxy-admin", ReaderRole: "galaxy-reader"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = func() time.Time { return time.Unix(at, 0) }
	authority := access.NewWebEventAuthority(gateway)
	authority.Devices = device
	events := &webevents.Service{Pool: api, Endpoint: endpoint, Authority: authority}
	defer events.Stop()
	server := httptest.NewServer(webevents.Handler{Service: events, Heartbeat: 20 * time.Millisecond})
	defer server.Close()
	request := func(path, kind string) *http.Request {
		t.Helper()
		r, _ := http.NewRequestWithContext(ctx, "GET", server.URL+path, nil)
		switch kind {
		case "portal":
			r.Header.Set("Origin", gateway.Config.WebsiteOrigin)
			r.Header.Set("X-Galaxy-Account-ID", account)
			r.AddCookie(&http.Cookie{Name: "__Host-galaxy-account", Value: portalToken})
		case "ambient":
			r.AddCookie(&http.Cookie{Name: "__Host-galaxy-account", Value: portalToken})
		case "device":
			r.Header.Set("Authorization", "Bearer "+deviceToken)
		}
		return r
	}
	poll := func(path, kind string) (int, map[string]any) {
		t.Helper()
		response, e := http.DefaultClient.Do(request(path, kind))
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		if strings.Contains(string(raw), "PRIVATE_PROFILE_BODY") || strings.Contains(string(raw), "source_ref") {
			t.Fatal("event disclosed source body")
		}
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			t.Fatalf("invalid event HTTP %d %s", response.StatusCode, raw)
		}
		return response.StatusCode, value
	}
	position, e := events.Position(ctx)
	if e != nil {
		t.Fatal(e)
	}
	execute("UPDATE official_account_profiles_v1 SET revision=revision+1 WHERE account_id IN($1,$2)", account, other)
	path := "/v1/web-events?stream=false&topics=account&cursor=" + position
	status, value := poll(path, "portal")
	if status != 200 {
		t.Fatalf("portal SSE headers require extra business fields: %d %+v", status, value)
	}
	changes := 0
	for _, raw := range value["events"].([]any) {
		if raw.(map[string]any)["type"] == "change" {
			changes++
		}
	}
	if changes != 1 {
		t.Fatalf("portal source scope allowed %d changes", changes)
	}
	status, value = poll(path, "ambient")
	if status != 200 {
		t.Fatal("cookie without explicit account was not anonymous")
	}
	for _, raw := range value["events"].([]any) {
		if raw.(map[string]any)["type"] == "change" {
			t.Fatal("ambient cookie selected a private account")
		}
	}
	status, value = poll(path, "device")
	if status != 200 {
		t.Fatalf("device binding subscription needs unrelated headers %d %+v", status, value)
	}
	for _, raw := range value["events"].([]any) {
		if raw.(map[string]any)["type"] == "change" {
			t.Fatal("device auto-selected a linked account")
		}
	}
	mixed := request(path, "portal")
	mixed.Header.Set("Authorization", "Bearer invalid")
	response, e := http.DefaultClient.Do(mixed)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("invalid device bearer fell back to ambient portal cookie")
	}
	actor, e := device.Authenticate(ctx, deviceToken, "binding")
	if e != nil {
		t.Fatal(e)
	}
	principal, e := authority.AuthorizeConnection(ctx, request("/v1/web-events", "device"), "web")
	if e != nil {
		t.Fatal(e)
	}
	decision, e := authority.AuthorizeSource(ctx, principal, webevents.Event{Module: "contacts", SourceTable: "contacts_v2", Ref: map[string]any{"id": uuid.NewString(), "initiator_id": actor.SubjectID, "recipient_id": "other"}})
	if e != nil || decision != webevents.Allowed {
		t.Fatalf("current binding participant refused: %v %v", decision, e)
	}
	foreign := principal
	foreign.SubjectID = "untrusted"
	decision, e = authority.AuthorizeSource(ctx, foreign, webevents.Event{Module: "contacts", SourceTable: "contacts_v2", Ref: map[string]any{"initiator_id": "untrusted", "recipient_id": "other"}})
	if e != nil || decision != webevents.Denied {
		t.Fatal("client subject substituted verified device authority")
	}
	// Both identity types clear subscribed projections on confirmed loss; a
	// stream supplies no write-CSRF or ordinary operation/idempotency headers.
	stream := func(kind string) *http.Response {
		t.Helper()
		response, e := http.DefaultClient.Do(request("/v1/web-events?topics=account", kind))
		if e != nil {
			t.Fatal(e)
		}
		if response.StatusCode != 200 {
			t.Fatalf("stream %s=%d", kind, response.StatusCode)
		}
		return response
	}
	readSnapshot := func(response *http.Response) *bufio.Reader {
		t.Helper()
		reader := bufio.NewReader(response.Body)
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				t.Fatal(e)
			}
			if strings.Contains(line, `"snapshot"`) {
				return reader
			}
		}
	}
	response = stream("portal")
	reader := readSnapshot(response)
	execute("UPDATE official_account_sessions_v1 SET revoked_at=$2 WHERE token_hash=$1", identity.Digest([]byte(portalToken)), at)
	raw, e := io.ReadAll(reader)
	response.Body.Close()
	if e != nil || !strings.Contains(string(raw), `"reset"`) {
		t.Fatalf("portal revocation did not reset %s %v", raw, e)
	}
	response = stream("device")
	reader = readSnapshot(response)
	execute("UPDATE access_credentials SET revoked_at=$2 WHERE token_hash=$1", identity.Digest([]byte(deviceToken)), time.Unix(at, 0))
	raw, e = io.ReadAll(reader)
	response.Body.Close()
	if e != nil || !strings.Contains(string(raw), `"reset"`) {
		t.Fatalf("device revocation did not reset %s %v", raw, e)
	}
	_, e = authority.AuthorizeConnection(ctx, request("/v1/web-events", "device"), "web")
	if fault.Status(e) != 401 {
		t.Fatalf("revoked controlled device stayed subscribed: %v", e)
	}
}
