package systemsettings_test

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	m "github.com/agigalaxy-team/agigalaxy/go/internal/managementaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publication"
	s "github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type routed struct{ origin *url.URL }

func (t routed) RoundTrip(req *http.Request) (*http.Response, error) {
	c := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = t.origin.Scheme
	u.Host = t.origin.Host
	c.URL = &u
	return http.DefaultTransport.RoundTrip(c)
}

type currentRoles struct{ native *m.Native }

func (d currentRoles) Roles(ctx context.Context, i, sub string) ([]string, error) {
	return d.RolesFresh(ctx, i, sub)
}
func (d currentRoles) RolesFresh(ctx context.Context, i, sub string) ([]string, error) {
	u, e := d.native.Get(ctx, i, sub)
	if e != nil {
		return nil, e
	}
	if u == nil || !u.Enabled {
		return []string{}, nil
	}
	return []string{"admit-" + u.Admission}, nil
}
func TestSettingsDurableNativeMailBridgeAndGeneralPublicationTransaction(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	node := func(mode string, input object) object {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/system-settings-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		cmd.Stdin = strings.NewReader(encode(input))
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original %s %v %s", mode, e, out)
		}
		var o object
		if json.Unmarshal(out, &o) != nil {
			t.Fatal("invalid source result")
		}
		return o
	}
	base := node("setup", object{})
	endpoint, issuer := str(base["endpoint"]), str(base["issuer"])
	now := func() time.Time { return time.Unix(2000000000, 0) }
	key := strings.Repeat("K", 40)
	connectionID, credentialID := uuid.NewString(), uuid.NewString()
	var mu sync.Mutex
	wire := []any{}
	receipts := map[string]object{}
	submitted := map[string]int{}
	lostApply := false
	marker := str(base["publication"])
	apiURL := ""
	var internalFailure string
	internalCall := func(path string, input object) (int, object) {
		raw := encode(input)
		id, at := uuid.NewString(), "2000000000"
		req, _ := http.NewRequest("POST", apiURL+path, strings.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Galaxy-Service-Key", key)
		req.Header.Set("X-Galaxy-Request-Id", id)
		req.Header.Set("X-Galaxy-Request-At", at)
		req.Header.Set("X-Galaxy-Service-Signature", maintenance.Signature(key, id, at, []byte(raw)))
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			return 0, object{"error": "fixture_transport"}
		}
		defer res.Body.Close()
		var o object
		json.NewDecoder(res.Body).Decode(&o)
		return res.StatusCode, o
	}
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(req.URL.Path, "/token") {
			json.NewEncoder(w).Encode(object{"access_token": "isolated-token", "expires_in": 300})
			return
		}
		if strings.Contains(req.URL.Path, "/admin/realms/management/users/") {
			sub := strings.TrimPrefix(req.URL.Path, "/admin/realms/management/users/")
			if strings.HasSuffix(sub, "/composite") {
				role := "reader"
				if strings.HasPrefix(sub, "root/") {
					role = "administrator"
				}
				json.NewEncoder(w).Encode([]any{object{"name": "admit-" + role}})
			} else {
				json.NewEncoder(w).Encode(object{"id": sub, "username": sub, "enabled": true, "emailVerified": true})
			}
			return
		}
		if req.URL.Path == "/site-publication.json" {
			mu.Lock()
			id := marker
			mu.Unlock()
			json.NewEncoder(w).Encode(object{"version": 1, "publicationId": id})
			return
		}
		raw, _ := io.ReadAll(req.Body)
		var input object
		if json.Unmarshal(raw, &input) != nil {
			w.WriteHeader(400)
			return
		}
		kind := str(input["kind"])
		if req.URL.Path != "/fixture-native" {
			headers := object{}
			for _, h := range []string{"x-galaxy-service-key", "x-galaxy-request-id", "x-galaxy-request-at", "x-galaxy-service-signature"} {
				headers[h] = req.Header.Get(h)
			}
			mu.Lock()
			wire = append(wire, object{"headers": headers, "body": string(raw)})
			mu.Unlock()
			if req.Header.Get("X-Galaxy-Service-Signature") != maintenance.Signature(key, req.Header.Get("X-Galaxy-Request-Id"), req.Header.Get("X-Galaxy-Request-At"), raw) {
				w.WriteHeader(401)
				return
			}
		}
		if kind == "settings-overview" {
			json.NewEncoder(w).Encode(object{"availability": object{"state": "available"}, "current": []any{}, "credentials": []any{}, "observedConfiguration": nil, "capabilities": object{"canTest": true, "canApply": true, "canWriteCredential": true}})
			return
		}
		if kind == "settings-operation" {
			mu.Lock()
			receipt := receipts[str(input["operationId"])]
			mu.Unlock()
			if receipt == nil {
				json.NewEncoder(w).Encode(object{"state": "not-recorded"})
			} else {
				json.NewEncoder(w).Encode(object{"operation": receipt})
			}
			return
		}
		intent := copyObject(input)
		delete(intent, "credential")
		status, auth := internalCall("/v1/internal/system-settings/authorize", intent)
		if status != 200 {
			mu.Lock()
			internalFailure = "authorize: " + encode(auth)
			mu.Unlock()
			w.WriteHeader(503)
			return
		}
		if kind == "settings-apply" && input["section"] == "mail" {
			status, applied := internalCall("/v1/internal/system-settings/mail", object{"kind": "operations-apply", "intent": intent})
			if status != 200 || applied["state"] != "completed" {
				mu.Lock()
				internalFailure = "mail bridge: " + encode(applied)
				mu.Unlock()
				w.WriteHeader(503)
				return
			}
		}
		opKind := "credential"
		if kind == "settings-test" {
			opKind = "test"
		} else if kind == "settings-apply" {
			opKind = "apply"
		}
		revision := input["revision"]
		versionID := input["versionId"]
		if opKind == "credential" {
			revision = input["expectedRevision"]
		}
		receipt := object{"operationId": input["operationId"], "section": input["section"], "kind": opKind, "state": "completed", "versionId": versionID, "revision": revision, "phases": []any{object{"target": "operations", "state": "completed", "code": nil, "adoptedVersionId": versionID}}, "startedAt": "2033-05-18T03:33:20.000Z", "finishedAt": "2033-05-18T03:33:20.000Z"}
		if opKind == "credential" {
			receipt["credentialRef"] = "system-key:" + str(input["operationId"])
		}
		mu.Lock()
		receipts[str(input["operationId"])] = receipt
		submitted[kind]++
		drop := lostApply && opKind == "apply"
		if drop {
			lostApply = false
		}
		mu.Unlock()
		if drop {
			c, _, _ := w.(http.Hijacker).Hijack()
			c.Close()
			return
		}
		json.NewEncoder(w).Encode(receipt)
	}))
	defer host.Close()
	origin, _ := url.Parse(host.URL)
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	management, e := m.NewNative(m.NativeConfig{Issuer: issuer, Reader: m.Credential{ClientID: "reader", ClientSecret: "isolated-reader"}, AdministratorRole: "admit-administrator", ReaderRole: "admit-reader", Transport: routed{origin}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://website.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-administrator", ReaderRole: "admit-reader", Root: &access.Root{Issuer: issuer, Subject: "root", OperatorID: str(obj(base["ids"])["root"])}}, currentRoles{management})
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = now
	native := &s.NativeClient{Client: maintenance.New(maintenance.Configuration{SocketPath: "/run/galaxy-maintenance/isolated.sock", Key: key}, maintenance.Options{Now: now, Transport: routed{origin}})}
	service := &s.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), Native: native, Now: now}
	credentialDir := t.TempDir()
	credentialFile := filepath.Join(credentialDir, "smtp-credentials.json")
	credentialEntries := []messaging.CredentialBinding{{Ref: "system-key-" + credentialID, Label: "Isolated approved binding", Host: "smtp.example.invalid", Port: 465, TLS: "implicit", Purposes: []string{"account", "notice", "community", "updates", "team"}, User: "isolated-user", Password: "isolated-password"}}
	if e = os.WriteFile(credentialFile, []byte(encode(object{"version": 1, "endpoint": endpoint, "credentials": credentialEntries})), 0600); e != nil {
		t.Fatal(e)
	}
	credentials, e := messaging.NewRefreshingCredentials(credentialFile, endpoint)
	if e != nil {
		t.Fatal(e)
	}
	smtp := &messaging.SMTPService{Pool: pool, Endpoint: endpoint, Authority: gateway, Credentials: credentials, Now: now}
	bridge := &s.MailBridge{Settings: service, SMTP: smtp}
	tx, e := admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, admin, tx); e == nil {
		e = jobs.ProvisionRolesWithin(ctx, tx)
	}
	if e == nil {
		_, e = tx.Exec(ctx, "INSERT INTO galaxy_go_jobs.control_v1(endpoint,backend) VALUES($1,'river')", endpoint)
	}
	if e != nil {
		tx.Rollback(ctx)
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	queue, e := jobs.New(pool, nil)
	if e != nil {
		t.Fatal(e)
	}
	commands := &publication.Commands{Pool: pool, Endpoint: endpoint, Queue: queue, Now: now}
	general := &s.General{Settings: service, Publications: commands, WebsiteOrigin: "https://website.example.invalid", Client: &http.Client{Transport: routed{origin}}}
	api := httptest.NewServer(s.Handler{Service: service, Native: native, Mail: bridge, General: general})
	defer api.Close()
	apiURL = api.URL
	request := func(method, path string, input object) (int, object) {
		t.Helper()
		raw := ""
		if input != nil {
			raw = encode(input)
		}
		req, _ := http.NewRequest(method, api.URL+"/v1/operations/system-settings"+path, strings.NewReader(raw))
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("E", 43)})
		res, e := api.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var o object
		if json.NewDecoder(res.Body).Decode(&o) != nil {
			t.Fatal("invalid HTTP JSON")
		}
		if res.StatusCode == 200 && (res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Referrer-Policy") != "no-referrer") {
			t.Fatal("private metadata cache policy lost")
		}
		return res.StatusCode, o
	}
	check := func(status int, o object) {
		t.Helper()
		if status != 200 {
			t.Fatalf("HTTP %d %s native=%s", status, encode(o), internalFailure)
		}
	}
	equal := func(label string, a, b any) {
		t.Helper()
		var left, right any
		json.Unmarshal([]byte(encode(a)), &left)
		json.Unmarshal([]byte(encode(b)), &right)
		if !reflect.DeepEqual(left, right) {
			t.Fatalf("%s\nGo%s\nJS%s", label, encode(a), encode(b))
		}
	}
	original := func(mode, section, id string, input object) object {
		return node(mode, object{"origin": host.URL, "section": section, "id": id, "input": input})
	}
	status, out := request("GET", "/mail", nil)
	check(status, out)
	equal("empty observed mail", out, original("read", "mail", "", nil))
	conn := object{"id": connectionID, "name": "原邮件连接", "host": "SMTP.EXAMPLE.INVALID", "port": 465, "tls": "implicit", "credentialRef": "system-key:" + credentialID, "connectionTimeoutMs": nil, "greetingTimeoutMs": nil, "socketTimeoutMs": nil, "maxConnections": nil, "rateLimit": nil, "rateWindowSeconds": nil, "dkimSelector": nil}
	configuration := object{"connections": []any{conn}, "bindings": object{"operations": connectionID, "account-authentication": nil, "runtime-alerts": nil}}
	save := object{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": configuration}
	status, out = request("POST", "/mail/versions", save)
	check(status, out)
	version := obj(out["version"])
	sourceSaved := node("command", object{"origin": host.URL, "section": "mail", "kind": "save", "input": save})
	sourceSaved["replayed"] = out["replayed"]
	equal("original saved operation", out, sourceSaved)
	incomplete := object{"operationId": uuid.NewString(), "expectedRevision": 1, "versionId": version["id"]}
	status, out = request("POST", "/mail/apply", incomplete)
	if status != 409 || out["error"] != "system_settings_configuration_incomplete" {
		t.Fatalf("incomplete apply %d %s", status, encode(out))
	}
	var claimed int
	admin.QueryRow(ctx, "SELECT count(*) FROM operations_system_settings_commands_v1 WHERE operation_id=$1", incomplete["operationId"]).Scan(&claimed)
	if claimed != 0 {
		t.Fatal("incomplete draft claimed Native command")
	}
	for k, v := range map[string]any{"connectionTimeoutMs": 5000, "greetingTimeoutMs": 5000, "socketTimeoutMs": 5000, "maxConnections": 2, "rateLimit": 20, "rateWindowSeconds": 60} {
		conn[k] = v
	}
	save = object{"operationId": uuid.NewString(), "expectedRevision": 1, "configuration": configuration}
	status, out = request("POST", "/mail/versions", save)
	check(status, out)
	version = obj(out["version"])
	status, out = request("GET", "/mail", nil)
	check(status, out)
	equal("saved current mail", out, original("read", "mail", "", nil))
	apply := object{"operationId": uuid.NewString(), "expectedRevision": 2, "versionId": version["id"]}
	mu.Lock()
	lostApply = true
	mu.Unlock()
	status, out = request("POST", "/mail/apply", apply)
	check(status, out)
	if obj(out["operation"])["state"] != "unknown" {
		t.Fatalf("lost ACK original intent %s native=%s", encode(out), internalFailure)
	}
	status, out = request("GET", "/operations/"+str(apply["operationId"]), nil)
	check(status, out)
	if obj(out["operation"])["state"] != "completed" {
		t.Fatalf("original receipt recovery %s", encode(out))
	}
	equal("recovered operation", out, original("operation", "", str(apply["operationId"]), nil))
	status, out = request("POST", "/mail/apply", apply)
	check(status, out)
	if out["replayed"] != true {
		t.Fatal("apply replay lost")
	}
	if submitted["settings-apply"] != 1 {
		t.Fatal("lost ACK apply resent")
	}
	status, readback := internalCall("/v1/internal/system-settings/mail", object{"kind": "operations-readback", "operationId": apply["operationId"], "operatorId": obj(base["ids"])["editor"]})
	check(status, readback)
	if readback["state"] != "completed" || readback["configurationVersion"] != float64(1) {
		t.Fatalf("actual SMTP readback %s", encode(readback))
	}
	test := object{"operationId": uuid.NewString(), "expectedRevision": 2, "versionId": version["id"], "connectionId": connectionID}
	status, out = request("POST", "/mail/test", test)
	check(status, out)
	if obj(out["operation"])["state"] != "completed" {
		t.Fatalf("Native test receipt %s", encode(out))
	}
	provisionID := uuid.NewString()
	credential := object{"operationId": provisionID, "expectedRevision": 2, "connectionId": connectionID, "section": "mail", "binding": object{"id": connectionID, "host": "smtp.example.invalid", "port": 465, "tls": "implicit"}, "credential": object{"user": "isolated-provision-user", "password": "isolated-provision-private"}}
	status, out = request("POST", "/credentials", credential)
	check(status, out)
	if obj(out["operation"])["credentialRef"] != "system-key:"+provisionID {
		t.Fatalf("credential purpose reference %s", encode(out))
	}
	var leaked bool
	admin.QueryRow(ctx, "SELECT input::text LIKE '%isolated-provision-private%' OR result::text LIKE '%isolated-provision-private%' FROM operations_system_settings_commands_v1 WHERE operation_id=$1", provisionID).Scan(&leaked)
	if leaked {
		t.Fatal("provision secret persisted in PG")
	}
	for _, path := range []string{"/mail/history", "/advanced", "/overview"} {
		status, out = request("GET", path, nil)
		check(status, out)
		mode := "history"
		if path == "/advanced" {
			mode = "advanced"
		} else if path == "/overview" {
			mode = "overview"
		}
		equal("current "+path, out, original(mode, "mail", "", nil))
	}
	status, out = request("GET", "/general/publication", nil)
	check(status, out)
	equal("public website source", out, original("general-source", "", "", nil))
	publish := object{"operationId": uuid.NewString(), "expectedPublicationId": base["publication"], "settingsRevision": 3, "versionId": uuid.NewString(), "settings": object{"siteTitle": strings.Repeat("😀", 120), "description": "原网站一般设置", "footerLinks": []any{}}}
	status, out = request("POST", "/general/publish", publish)
	check(status, out)
	if obj(out["operation"])["state"] != "accepted" {
		t.Fatalf("same transaction publication %s", encode(out))
	}
	equal("general original operation", out, original("general-operation", "", str(publish["operationId"]), nil))
	var publishedJobs int
	admin.QueryRow(ctx, "SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE source_id=$1 AND action='content-publication'", publish["operationId"]).Scan(&publishedJobs)
	if publishedJobs != 1 {
		t.Fatalf("publication queue intent %d", publishedJobs)
	}
	commands.Queue = nil
	rollback := copyObject(publish)
	rollback["operationId"] = uuid.NewString()
	status, out = request("POST", "/general/publish", rollback)
	if status != 503 {
		t.Fatalf("queue failure %d %s", status, encode(out))
	}
	var leftovers int
	admin.QueryRow(ctx, "SELECT (SELECT count(*) FROM site_publications_v1 WHERE id=$1)+(SELECT count(*) FROM operations_system_general_publications_v1 WHERE operation_id=$1)+(SELECT count(*) FROM galaxy_go_jobs.executions_v1 WHERE source_id=$1)", rollback["operationId"]).Scan(&leftovers)
	if leftovers != 0 {
		t.Fatal("publication/queue transaction left partial records")
	}

	metadataFile := filepath.Join(credentialDir, "mail-metadata.json")
	metadata := object{"version": 1, "versionId": version["id"], "connection": conn}
	if e = os.WriteFile(metadataFile, []byte(encode(metadata)), 0600); e != nil {
		t.Fatal(e)
	}
	var adoptedReceipt object
	adopted := s.ReportOperationsMailAdoption(ctx, metadataFile, "api", smtp, credentialFile, s.AdoptionOptions{PID: 1234, Now: now, WriteReceipt: func(path string, value object) error {
		if path != s.OperationsMailReceiptFiles["api"] {
			t.Fatal("mail receipt destination widened")
		}
		adoptedReceipt = value
		return os.WriteFile(filepath.Join(credentialDir, "adopted.json"), []byte(encode(value)), 0600)
	}})
	if adopted["state"] != "recorded" {
		t.Fatalf("same SMTP actual adoption %s", encode(adopted))
	}
	sourceAdoption := node("mail-adoption", object{"origin": host.URL, "metadataFile": metadataFile, "credentialFile": credentialFile})
	equal("original actual mail adoption", object{"result": adopted, "receipt": adoptedReceipt}, sourceAdoption)
	if strings.Contains(encode(adoptedReceipt), "isolated-password") {
		t.Fatal("SMTP credential leaked to receipt")
	}
	changedConnection := copyObject(conn)
	changedConnection["socketTimeoutMs"] = 6000
	metadata["connection"] = changedConnection
	os.WriteFile(metadataFile, []byte(encode(metadata)), 0600)
	if got := s.ReportOperationsMailAdoption(ctx, metadataFile, "api", smtp, credentialFile, s.AdoptionOptions{PID: 1234, Now: now, WriteReceipt: func(string, object) error { t.Fatal("unadopted configuration wrote receipt"); return nil }}); got["state"] != "unavailable" {
		t.Fatal("submitted metadata substituted current SMTP")
	}
	privateRaw := `{"kind":"operations-overview"}`
	bad, _ := http.NewRequest("POST", api.URL+"/v1/internal/system-settings/mail", strings.NewReader(privateRaw))
	bad.Header.Set("Content-Type", "application/json")
	bad.Header.Set("X-Galaxy-Service-Key", "wrong")
	badRes, err := api.Client().Do(bad)
	if err != nil {
		t.Fatal(err)
	}
	badRes.Body.Close()
	if badRes.StatusCode != 401 {
		t.Fatal("browser/private credential confusion accepted")
	}
	mu.Lock()
	requests := append([]any(nil), wire...)
	mu.Unlock()
	verified := node("wire", object{"key": key, "requests": requests})
	for _, v := range verified["results"].([]any) {
		if v != true {
			t.Fatal("original Node HMAC verifier rejected exact Go bytes")
		}
	}
}
