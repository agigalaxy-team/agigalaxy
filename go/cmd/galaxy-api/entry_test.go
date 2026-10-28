package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

func TestDevelopmentEntryComposesOriginalAssetsAndBoundaries(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("production entry rejects root runtime")
	}
	_, dsn := testsupport.PostgreSQL(t)
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	setup := exec.Command("node", filepath.Join(root, "scripts/go/feedback-fixture.mjs"), "setup")
	setup.Dir, setup.Env = root, append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if _, err := setup.Output(); err != nil {
		t.Fatal("isolated original schema setup failed")
	}
	config := exec.Command("node", filepath.Join(root, "scripts/go/access-fixture.mjs"), t.TempDir())
	config.Dir = root
	raw, err := config.Output()
	if err != nil {
		t.Fatal("isolated original configuration fixture failed")
	}
	var files struct{ Endpoint, AccountFile, OperationsFile, IdentityFile string }
	if json.Unmarshal(raw, &files) != nil {
		t.Fatal("configuration result invalid")
	}
	// The existing installation records current registries before readers use
	// them. Seed that original source in this isolated cluster, never bypass it.
	registry := exec.Command("node", filepath.Join(root, "scripts/go/feedback-fixture.mjs"), "entry-runtime", files.Endpoint)
	registry.Dir, registry.Env = root, append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if output, err := registry.CombinedOutput(); err != nil {
		t.Fatalf("original entry registry %v %s", err, output)
	}
	// The real entry reads configuration, but this test never discovers or calls
	// the fixture .invalid identity servers and never uses host credentials.
	for _, key := range []string{"GALAXY_CHAT_CONFIG_FILE", "GALAXY_ATTACHMENTS_CONFIG_FILE", "CREDENTIALS_DIRECTORY", "GALAXY_EXTERNAL_CREDENTIALS_CONFIG_FILE", "GALAXY_SIGNING_KEY_FILE", "GALAXY_SIGNING_KEY_ID", "GALAXY_ROOT_PINS_FILE", "GALAXY_KEYRING_FILE", "GALAXY_TRUST_DIRECTORY", "GALAXY_RETIREMENT_FILE", "GALAXY_INCIDENT_FILE", "GALAXY_RESOURCE_BUDGET_FILE", "GALAXY_FORUM_POLICY_FILE", "GALAXY_COMMUNITY_QUOTA_FILE", "GALAXY_GOVERNANCE_CONFIG", "GALAXY_GOVERNANCE_REVIEW_FILE", "GALAXY_GOVERNANCE_AUTHORITIES_FILE", "GALAXY_BROWSER_POLICY_FILE", "GALAXY_REQUEST_QUOTA_FILE", "GALAXY_TRUSTED_PROXY_ADDRESSES", "GALAXY_DISCOVERY_CONFIG_FILE", "GALAXY_SYSTEM_SETTINGS_NATIVE_FILE", "GALAXY_MAINTENANCE_NATIVE_FILE", "GALAXY_MODEL_SETTINGS_NATIVE_FILE", "GALAXY_SERVICE_CONNECTIONS_METADATA_FILE", "GALAXY_SYSTEM_SETTINGS_MAIL_METADATA_FILE", "GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE"} {
		t.Setenv(key, "")
	}
	for _, key := range []string{"GALAXY_METRICS_PORT", "GALAXY_METRICS_STORAGE_DIRECTORY", "GALAXY_METRICS_COST_FILE", "GALAXY_BACKUP_STATUS_DIRECTORY", "GALAXY_METRICS_BACKUP_ACTIONS", "GALAXY_RUNTIME_LOG_DIRECTORY", "GALAXY_RUNTIME_LOG_INSTANCE", "GALAXY_RUNTIME_LOG_ROTATE_BYTES", "GALAXY_RUNTIME_LOG_MAX_FILES"} {
		value, present := os.LookupEnv(key)
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if present {
				_ = os.Setenv(key, value)
			} else {
				_ = os.Unsetenv(key)
			}
		})
	}
	for key, value := range map[string]string{"DATABASE_URL": dsn, "GALAXY_ENDPOINT": files.Endpoint, "GALAXY_ACCOUNT_CONFIG_FILE": files.AccountFile, "GALAXY_OPERATIONS_CONFIG_FILE": files.OperationsFile, "GALAXY_IDENTITY_CONFIG_FILE": files.IdentityFile, "GALAXY_ENVIRONMENT": "local", "GALAXY_LISTEN_HOST": "127.0.0.1", "GALAXY_PUBLIC_DOCS_FILE": filepath.Join(root, "packages/galaxy-official/public-docs.json")} {
		t.Setenv(key, value)
	}
	browserPolicy := filepath.Join(t.TempDir(), "browser.json")
	if err := os.WriteFile(browserPolicy, []byte(`{"version":1,"origins":["https://web.example.invalid"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GALAXY_BROWSER_POLICY_FILE", browserPolicy)
	t.Setenv("GALAXY_AGENTOS_CONFIG_FILE", "")
	for _, key := range []string{"GALAXY_PERSONAL_MCP_CONFIG_FILE", "GALAXY_RELEASE_DIRECTORY", "GALAXY_RELEASE_SHA256", "GALAXY_CONFIGURATION_VERSION"} {
		t.Setenv(key, "")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	t.Setenv("PORT", fmt.Sprint(port))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(fault.Code(err))
			}
		case <-time.After(12 * time.Second):
			t.Error("API did not stop")
		}
	})
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	call := func(method, path, body string) (int, []byte, error) {
		r, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), strings.NewReader(body))
		if err != nil {
			return 0, nil, err
		}
		r.Host = "api.example.invalid"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		if strings.HasPrefix(path, "/v1/operations/") {
			r.Header.Set("Origin", "https://admin.example.invalid")
		}
		if strings.HasPrefix(path, "/v2/chat/") {
			r.Header.Set("Origin", "https://web.example.invalid")
		}
		resp, err := client.Do(r)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(io.LimitReader(resp.Body, 65536))
		return resp.StatusCode, b, err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, _, err := call("GET", "/healthz", "")
		if err == nil && status == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("API did not become live")
		}
		time.Sleep(20 * time.Millisecond)
	}
	for path, want := range map[string]int{"/readyz": 503, "/v1/service-status": 200, "/v2/community/sections": 200, "/v1/account/session": 200} {
		status, _, err := call("GET", path, "")
		if err != nil || status != want {
			t.Fatalf("%s status %d want %d", path, status, want)
		}
	}
	for _, check := range []struct {
		method, path string
		want         int
	}{
		{"GET", "/v1/operations/permissions/catalog", 401},
		{"GET", "/v1/operations/permissions/automation", 401},
		{"GET", "/v1/operations/agentos/status", 401},
		{"GET", "/v1/operations/messaging/plans", 401},
		{"GET", "/v1/operations/smtp", 401},
		{"GET", "/v1/operations/management-accounts", 401},
		{"GET", "/v1/operations/maintenance/overview", 401},
		{"GET", "/v1/operations/model-settings/overview", 401},
		{"GET", "/v1/operations/community/sections", 401},
		{"GET", "/v1/operations/agentos/options", 401},
		{"GET", "/v1/operations/strategies/overview", 401},
		{"GET", "/v1/operations/resources/projects", 401},
		{"GET", "/v1/operations/summary", 401},
		{"POST", "/v2/personal-summaries/list", 503},
		{"POST", "/v2/verification-records/read", 401},
		{"POST", "/v1/evidence-submissions", 401},
		{"POST", "/v2/projects", 503},
		{"POST", "/v2/comments", 503},
		{"POST", "/v2/chat/rooms/query", 401},
		{"POST", "/v1/data-exports/specification", 503},
		{"POST", "/v1/profiles/current", 401},
		{"POST", "/v1/history/query", 503},
		{"POST", "/v1/builders/specification", 200},
		{"POST", "/v1/builders/manage/read", 401},
		{"POST", "/v1/builders/node-control/export", 401},
		{"POST", "/v2/contributions/status", 503},
		{"POST", "/v2/hubs/status", 200},
		{"POST", "/v1/search/query", 400},
		{"POST", "/v2/information/query", 400},
		{"POST", "/v2/requester-history/query", 400},
	} {
		status, body, err := call(check.method, check.path, `{}`)
		if err != nil || status != check.want {
			t.Fatalf("%s %s status %d want %d: %s", check.method, check.path, status, check.want, body)
		}
	}
	status, body, err := call("POST", "/mcp/docs", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"isolated-entry","version":"1"}}}`)
	if err != nil || status != 200 {
		t.Fatalf("real docs initialize status %d", status)
	}
	var result map[string]any
	if json.Unmarshal(body, &result) != nil || result["result"] == nil {
		t.Fatal("docs did not return protocol result")
	}
}
