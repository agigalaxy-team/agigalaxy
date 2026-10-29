package access

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestCurrentIdentityDirectoryOriginalSourceAndProtectedReference(t *testing.T) {
	const issuer = "https://business.example.invalid/realms/users"
	mu := sync.Mutex{}
	user := map[string]any{"id": "subject", "email": "person@example.invalid", "emailVerified": true, "enabled": true}
	status, tokenCalls, userCalls := 200, 0, 0
	rejectOnce := false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/realms/users/protocol/openid-connect/token":
			tokenCalls++
			r.ParseForm()
			if r.Form.Get("client_id") != "fixture-reader" || r.Form.Get("client_secret") != "synthetic-local-secret" {
				w.WriteHeader(403)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "synthetic-local-token", "expires_in": 60})
		case "/admin/realms/users/users/subject":
			userCalls++
			if r.Header.Get("Authorization") != "Bearer synthetic-local-token" {
				w.WriteHeader(401)
				return
			}
			if rejectOnce {
				rejectOnce = false
				w.WriteHeader(401)
				return
			}
			if status != 200 {
				w.WriteHeader(status)
				return
			}
			json.NewEncoder(w).Encode(user)
		case "/admin/realms/users/users/subject/role-mappings/realm/composite":
			json.NewEncoder(w).Encode([]map[string]string{{"name": "cached-role"}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	directory, e := NewKeycloakDirectory(KeycloakConfig{Issuer: issuer, AdminOrigin: provider.URL, ClientID: "fixture-reader", ClientSecret: "synthetic-local-secret"})
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	identity, e := directory.LookupIdentity(ctx, issuer, "subject")
	if e != nil || identity.State != "available" || !identity.Enabled || !identity.EmailVerified || identity.Email != "person@example.invalid" {
		t.Fatal("fresh identity unavailable")
	}
	if _, e = directory.Roles(ctx, issuer, "subject"); e != nil {
		t.Fatal(e)
	}
	mu.Lock()
	user["enabled"], user["emailVerified"], user["email"] = false, false, "new@example.invalid"
	before := userCalls
	mu.Unlock()
	identity, e = directory.LookupIdentity(ctx, issuer, "subject")
	if e != nil || identity.Enabled || identity.EmailVerified || identity.Email != "new@example.invalid" {
		t.Fatal("cached roles substituted current delivery identity")
	}
	mu.Lock()
	actualCalls := userCalls
	rejectOnce = true
	mu.Unlock()
	if actualCalls != before+1 {
		t.Fatal("identity lookup did not read current provider")
	}
	if _, e = directory.LookupIdentity(ctx, issuer, "subject"); e != nil {
		t.Fatal("one-time token renewal failed")
	}
	mu.Lock()
	actualTokens := tokenCalls
	status = 503
	mu.Unlock()
	if actualTokens != 2 {
		t.Fatalf("token renewal count %d", actualTokens)
	}
	if _, e = directory.LookupIdentity(ctx, issuer, "subject"); e == nil {
		t.Fatal("directory failure reused stale address")
	}
	mu.Lock()
	status = 200
	user["id"] = "other"
	mu.Unlock()
	identity, e = directory.LookupIdentity(ctx, issuer, "subject")
	if e != nil || identity.State != "not-found" {
		t.Fatal("upstream subject mismatch accepted")
	}
	dir := t.TempDir()
	credential := filepath.Join(dir, "reader.json")
	os.WriteFile(credential, []byte(`{"version":1,"clientId":"fixture-reader","clientSecret":"synthetic-local-secret"}`), 0600)
	config := filepath.Join(dir, "operations.json")
	configValues := map[string]any{"version": 1, "issuer": "https://management.example.invalid/realms/management", "directoryOrigin": provider.URL, "accountDirectory": map[string]any{"issuer": issuer, "credentialFile": credential, "writerCredentialFile": filepath.Join(dir, "unread-writer-reference.json")}}
	b, _ := json.Marshal(configValues)
	os.WriteFile(config, b, 0600)
	loaded, e := LoadAccountDirectory(config)
	if e != nil || loaded == nil || loaded.issuer != issuer {
		t.Fatal("protected business directory did not load independently")
	}
	if _, e = os.Stat(filepath.Join(dir, "unread-writer-reference.json")); !os.IsNotExist(e) {
		t.Fatal("read-only directory touched writer credential")
	}
	t.Log("original current identity fields, fresh address/status reads, token renewal, failure/no-stale and read-only protected references passed")
}
