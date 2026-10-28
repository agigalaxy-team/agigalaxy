package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

// This opt-in harness owns only disposable data/configuration and a controlled
// current-directory protocol source. The ordinary run(ctx), HTTP routes, BFFs,
// permissions and business SQL are used without replacing business responses.
func TestFullEntryBrowserFlow(t *testing.T) {
	if os.Getenv("GALAXY_GO_FULL_ENTRY_BROWSER") != "true" {
		t.Skip("explicit full-entry browser cohort only")
	}
	if os.Geteuid() == 0 {
		t.Skip("normal API rejects root")
	}
	adminMode := os.Getenv("GALAXY_GO_BROWSER_ADMIN_MODE")
	if adminMode == "" {
		adminMode = "standalone"
	}
	if adminMode != "standalone" && adminMode != "development" {
		t.Fatal("admin mode must be standalone or development")
	}
	browserScope := os.Getenv("GALAXY_GO_FULL_ENTRY_BROWSER_SCOPE")
	if browserScope == "" {
		browserScope = "full"
	}
	if browserScope != "full" && browserScope != "admin" {
		t.Fatal("browser scope must be full or admin")
	}
	script := os.Getenv("GALAXY_GO_FULL_ENTRY_BROWSER_SCRIPT")
	pool, dsn := testsupport.PostgreSQL(t)
	root, e := filepath.Abs("../../..")
	if e != nil {
		t.Fatal(e)
	}
	if script == "" {
		script = filepath.Join(root, "scripts/go/full-api-browser.mjs")
	}
	if !filepath.IsAbs(script) {
		t.Fatal("absolute browser script required")
	}
	// Never inherit a real service reference into this isolated entry.
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "GALAXY_") || key == "CREDENTIALS_DIRECTORY" {
			if err := os.Unsetenv(key); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Setenv(key, value) })
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Minute)
	defer cancel()
	if _, e = databaseschema.Migrate(ctx, pool, nil); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "CREATE DATABASE galaxy_go_test_cms"); e != nil {
		t.Fatal(e)
	}
	cms, e := url.Parse(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cms.Path = "/galaxy_go_test_cms"
	directory := t.TempDir()
	freePort := func() int {
		t.Helper()
		l, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := l.Addr().(*net.TCPAddr).Port
		l.Close()
		return port
	}
	proxyPort, apiPort := freePort(), freePort()
	options := map[string]any{"endpoint": fmt.Sprintf("https://api.galaxy.localhost:%d", proxyPort), "websiteOrigin": fmt.Sprintf("https://web.galaxy.localhost:%d", proxyPort), "adminOrigin": fmt.Sprintf("https://admin.galaxy.localhost:%d", proxyPort)}
	writeJSON := func(path string, value any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	optionsFile := filepath.Join(directory, "origins.json")
	writeJSON(optionsFile, options)
	command := func(name string, args ...string) []byte {
		t.Helper()
		c := exec.CommandContext(ctx, "node", append([]string{filepath.Join(root, "scripts/go", name)}, args...)...)
		c.Dir = root
		c.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		raw, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated source %s: %v %s", name, err, raw)
		}
		return raw
	}
	raw := command("access-fixture.mjs", filepath.Join(directory, "portal"), optionsFile)
	var files map[string]any
	if e = json.Unmarshal(raw, &files); e != nil {
		t.Fatal(e)
	}
	filesJSON := filepath.Join(directory, "source-files.json")
	writeJSON(filesJSON, files)
	descriptorFile := filepath.Join(directory, "browser.json")
	command("full-api-browser-seed.mjs", filesJSON, descriptorFile)
	raw, e = os.ReadFile(descriptorFile)
	if e != nil {
		t.Fatal(e)
	}
	var descriptor map[string]any
	if e = json.Unmarshal(raw, &descriptor); e != nil {
		t.Fatal(e)
	}
	// A controlled Keycloak-compatible read source, not a Keycloak installation.
	// It knows exactly the temporary root subject and rejects all other requests.
	oidcKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var directoryReads atomic.Int64
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// The full entry eagerly discovers its association providers once a
		// device signer is present. Keep exact HTTPS issuer metadata and real
		// JWKS/algorithm configuration; only physical test transport is local.
		for _, realm := range []string{"management", "community"} {
			issuer := "https://login.example.invalid/realms/" + realm
			if r.Method == "GET" && r.URL.Path == "/realms/"+realm+"/.well-known/openid-configuration" {
				json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/protocol/openid-connect/token", "jwks_uri": issuer + "/jwks", "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "code_challenge_methods_supported": []string{"S256"}})
				return
			}
			if r.Method == "GET" && r.URL.Path == "/realms/"+realm+"/jwks" {
				json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "use": "sig", "kid": "isolated-browser-oidc", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(oidcKey.N.Bytes()), "e": "AQAB"}}})
				return
			}
		}
		if r.Method == "POST" && r.URL.Path == "/realms/management/protocol/openid-connect/token" {
			if r.ParseForm() != nil || r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_id") != "directory-reader" || r.Form.Get("client_secret") != "temporary-fixture-only" {
				http.Error(w, "denied", 401)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "isolated-directory-bearer", "expires_in": 120})
			return
		}
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer isolated-directory-bearer" {
			http.Error(w, "denied", 401)
			return
		}
		switch r.URL.Path {
		case "/admin/realms/management/users/fixture-root":
			directoryReads.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"id": "fixture-root", "enabled": true})
		case "/admin/realms/management/users/fixture-root/role-mappings/realm/composite":
			json.NewEncoder(w).Encode([]any{map[string]any{"name": "galaxy-administrator"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer source.Close()
	operationFile := files["operationsFile"].(string)
	raw, e = os.ReadFile(operationFile)
	if e != nil {
		t.Fatal(e)
	}
	var operations map[string]json.RawMessage
	if e = json.Unmarshal(raw, &operations); e != nil {
		t.Fatal(e)
	}
	directoryOriginJSON, err := json.Marshal(source.URL)
	if err != nil {
		t.Fatal(err)
	}
	// Keep raw roles JSON order: it participates in the original configuration ID.
	operations["directoryOrigin"] = directoryOriginJSON
	writeJSON(operationFile, operations)
	// Self-signed material belongs only to this test's proxy. No hosts file,
	// machine certificate store, production listener or user browser is changed.
	private, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	serial, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if e != nil {
		t.Fatal(e)
	}
	certificate := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "isolated-browser"}, DNSNames: []string{"api.galaxy.localhost", "web.galaxy.localhost", "admin.galaxy.localhost", "login.example.invalid"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, certificate, certificate, &private.PublicKey, private)
	if e != nil {
		t.Fatal(e)
	}
	privateDER, e := x509.MarshalPKCS8PrivateKey(private)
	if e != nil {
		t.Fatal(e)
	}
	certFile, keyFile := filepath.Join(directory, "proxy-cert.pem"), filepath.Join(directory, "proxy-key.pem")
	if e = os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}), 0600); e != nil {
		t.Fatal(e)
	}
	// Keep http.DefaultTransport a concrete Transport, including for native
	// clients that clone it. Only the fixture issuer dial is rerouted; normal
	// TLS hostname/certificate checks and OIDC signature checks stay enabled.
	issuerSource := httptest.NewUnstartedServer(source.Config.Handler)
	issuerSource.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: private}}}
	issuerSource.StartTLS()
	defer issuerSource.Close()
	issuerAddress := issuerSource.Listener.Addr().String()
	originalTransport := http.DefaultTransport
	localTransport := originalTransport.(*http.Transport).Clone()
	localTransport.Proxy = nil
	trust := x509.NewCertPool()
	parsedCertificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	trust.AddCert(parsedCertificate)
	localTransport.TLSClientConfig = &tls.Config{RootCAs: trust}
	originalDial := localTransport.DialContext
	localTransport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == "login.example.invalid:443" {
			address = issuerAddress
		}
		return originalDial(ctx, network, address)
	}
	http.DefaultTransport = localTransport
	defer func() { http.DefaultTransport = originalTransport; localTransport.CloseIdleConnections() }()
	browserFile := filepath.Join(directory, "browser-policy.json")
	writeJSON(browserFile, map[string]any{"version": 1, "origins": []string{options["websiteOrigin"].(string)}})
	serviceFiles := descriptor["serviceFiles"].(map[string]any)
	for key, value := range map[string]string{"DATABASE_URL": dsn, "GALAXY_ENDPOINT": files["endpoint"].(string), "GALAXY_ACCOUNT_CONFIG_FILE": files["accountFile"].(string), "GALAXY_OPERATIONS_CONFIG_FILE": operationFile, "GALAXY_IDENTITY_CONFIG_FILE": files["identityFile"].(string), "GALAXY_ENVIRONMENT": "local", "GALAXY_OPERATOR": "隔离 Go API", "GALAXY_REGION": "isolated-local", "GALAXY_LISTEN_HOST": "127.0.0.1", "PORT": fmt.Sprint(apiPort), "GALAXY_PUBLIC_DOCS_FILE": filepath.Join(root, "packages/galaxy-official/public-docs.json"), "GALAXY_BROWSER_POLICY_FILE": browserFile, "GALAXY_SIGNING_KEY_FILE": serviceFiles["signingKeyFile"].(string), "GALAXY_SIGNING_KEY_ID": serviceFiles["signingKeyId"].(string), "GALAXY_ROOT_PINS_FILE": serviceFiles["rootPinsFile"].(string), "GALAXY_KEYRING_FILE": serviceFiles["keyringFile"].(string), "GALAXY_TRUST_DIRECTORY": serviceFiles["trustDirectory"].(string)} {
		t.Setenv(key, value)
	}
	apiContext, stopAPI := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- run(apiContext) }()
	defer func() {
		stopAPI()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("full entry shutdown: %v", err)
			}
		case <-time.After(12 * time.Second):
			t.Error("full entry did not stop")
		}
	}()
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	api := fmt.Sprintf("http://127.0.0.1:%d", apiPort)
	for deadline := time.Now().Add(15 * time.Second); ; {
		select {
		case err := <-done:
			done <- err
			stopAPI()
			cancel()
			t.Fatalf("full entry stopped during startup: %v", err)
		default:
		}
		response, err := client.Get(api + "/healthz")
		if err == nil {
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("full entry startup timeout")
		}
		time.Sleep(25 * time.Millisecond)
	}
	// Seed the editor target through the complete real account HTTP consumer.
	people := descriptor["people"].([]any)
	person := people[0].(map[string]any)
	cookie := person["cookie"].(map[string]any)
	body, _ := json.Marshal(map[string]any{"operationId": uuid.NewString(), "body": "网页连续流程的真实反馈，等待后台处理。", "module": "community"})
	request, _ := http.NewRequestWithContext(ctx, "POST", api+"/v1/account/feedback", strings.NewReader(string(body)))
	publicAPI, _ := url.Parse(files["endpoint"].(string))
	request.Host = publicAPI.Host
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", options["websiteOrigin"].(string))
	request.Header.Set("X-Galaxy-Account-ID", person["accountId"].(string))
	request.Header.Set("X-Galaxy-Account-CSRF", person["csrf"].(string))
	request.AddCookie(&http.Cookie{Name: cookie["name"].(string), Value: cookie["value"].(string)})
	response, e := client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	raw, e = io.ReadAll(io.LimitReader(response.Body, 65536))
	response.Body.Close()
	if e != nil {
		t.Fatal(e)
	}
	if response.StatusCode != 201 {
		t.Fatalf("full entry feedback submit %d %s", response.StatusCode, raw)
	}
	var feedback map[string]any
	if e = json.Unmarshal(raw, &feedback); e != nil {
		t.Fatal(e)
	}
	descriptor["feedbackId"], descriptor["apiLoopback"], descriptor["cmsDatabaseURL"], descriptor["sourceRoot"] = feedback["feedbackId"], api, cms.String(), root
	descriptor["tlsCert"], descriptor["tlsKey"], descriptor["proxyPort"] = certFile, keyFile, proxyPort
	descriptor["currentDirectorySource"] = "controlled-loopback-protocol; not Keycloak"
	descriptor["browserScope"] = browserScope
	descriptor["adminMode"] = adminMode
	writeJSON(descriptorFile, descriptor)
	// Call the unchanged Admin session consumer directly with this real main
	// endpoint. It needs React.cache but no Next request context when its Headers
	// and environment are explicit. Output contains no identity/token values.
	preflight := exec.CommandContext(ctx, "node", "--input-type=module", "--eval", `
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const d=JSON.parse(await readFile(process.env.GALAXY_GO_BROWSER_DESCRIPTOR,'utf8'));
const {readOperatorSession}=await import(pathToFileURL(join(d.sourceRoot,'apps/galaxy-admin/src/lib/operations.mjs')).href);
try{
 const session=await readOperatorSession(new Headers({cookie:d.operator.cookie.name+'='+d.operator.cookie.value,'x-forwarded-for':'127.0.0.1'}),{environment:{publicOrigin:d.adminOrigin,bffOrigin:d.apiLoopback,fixtureCookies:false}});
 if(session.state!=='signed-in')throw Object.assign(Error('fixture session not signed in'),{code:'fixture_operator_not_signed_in'});
 console.log(JSON.stringify({consumer:'original-readOperatorSession',state:session.state,operatorIdType:typeof session.operator?.id,roleType:typeof session.operator?.role,csrfType:typeof session.csrfToken,expiryType:typeof session.expiresAt,authorizationVersionType:typeof session.operator?.businessAuthorization?.version,permissionCount:session.operator?.businessAuthorization?.permissions?.length??null}));
}catch(error){const code=typeof error?.code==='string'&&/^[a-z_]{1,80}$/.test(error.code)?error.code:'session_consumer_error';console.log(JSON.stringify({consumer:'original-readOperatorSession',state:'unknown',code}));process.exitCode=1;}
`)
	preflight.Dir = root
	preflight.Env = append(os.Environ(), "GALAXY_GO_BROWSER_DESCRIPTOR="+descriptorFile)
	preflightOutput, err := preflight.CombinedOutput()
	if err != nil {
		t.Fatalf("original Admin session consumer: %v %s", err, preflightOutput)
	}
	t.Log(string(preflightOutput))
	browser := exec.CommandContext(ctx, "node", script)
	browser.Dir = root
	browser.Env = append(os.Environ(), "GALAXY_GO_BROWSER_DESCRIPTOR="+descriptorFile)
	output, e := browser.CombinedOutput()
	if e != nil {
		t.Fatalf("full entry independent browser: %v %s", e, output)
	}
	t.Log(string(output))
	if directoryReads.Load() == 0 {
		t.Fatal("browser did not exercise current management directory")
	}
	var state string
	var revision int
	if e = pool.QueryRow(ctx, "SELECT state,revision FROM operations_feedback_v1 WHERE id=$1", feedback["feedbackId"]).Scan(&state, &revision); e != nil {
		t.Fatal(e)
	}
	if state != "processing" || revision != 2 {
		t.Fatalf("browser save missing from original ledger: %s %d", state, revision)
	}
}
