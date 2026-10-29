package accessfixture

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type Files struct {
	Endpoint       string `json:"endpoint"`
	AccountFile    string `json:"accountFile"`
	OperationsFile string `json:"operationsFile"`
	IdentityFile   string `json:"identityFile"`
	RootID         string `json:"rootID"`
}

// Create writes disposable public configuration and synthetic credentials.
func Create(t *testing.T, dir, endpoint, website, admin string) Files {
	t.Helper()
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	issuer, business := "https://login.example.invalid/realms/management", "https://login.example.invalid/realms/community"
	sum := sha256.Sum256([]byte(issuer + "\x00fixture-root"))
	rootID := hex.EncodeToString(sum[:])
	result := Files{Endpoint: endpoint, AccountFile: filepath.Join(dir, "account.json"), OperationsFile: filepath.Join(dir, "operations.json"), IdentityFile: filepath.Join(dir, "identity.json"), RootID: rootID}
	rootFile, credentialFile := filepath.Join(dir, "root.json"), filepath.Join(dir, "directory.json")
	write := func(path string, value any) {
		t.Helper()
		raw, e := json.Marshal(value)
		if e != nil {
			t.Fatal(e)
		}
		f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = f.Write(raw); e != nil {
			t.Fatal(e)
		}
		if e = f.Close(); e != nil {
			t.Fatal(e)
		}
	}
	write(rootFile, map[string]any{"version": 1, "endpoint": endpoint, "issuer": issuer, "externalSubject": "fixture-root", "operatorId": rootID})
	write(credentialFile, map[string]any{"version": 1, "clientId": "directory-reader", "clientSecret": "temporary-fixture-only"})
	write(result.AccountFile, map[string]any{"version": 1, "clientId": "website-account", "issuer": business, "websiteOrigin": website})
	// Role property order is part of the original persisted scope hash.
	write(result.OperationsFile, struct {
		Version int    `json:"version"`
		Admin   string `json:"adminOrigin"`
		Issuer  string `json:"issuer"`
		Client  string `json:"clientId"`
		Roles   struct {
			Reader        string `json:"reader"`
			Administrator string `json:"administrator"`
		} `json:"roles"`
		Credential string `json:"directoryCredentialFile"`
		Root       string `json:"rootOperatorFile"`
		Account    any    `json:"accountDirectory"`
	}{Version: 1, Admin: admin, Issuer: issuer, Client: "management", Roles: struct {
		Reader        string `json:"reader"`
		Administrator string `json:"administrator"`
	}{"galaxy-reader", "galaxy-administrator"}, Credential: credentialFile, Root: rootFile, Account: map[string]any{"issuer": business, "credentialFile": credentialFile}})
	write(result.IdentityFile, map[string]any{"version": 1, "providers": []any{map[string]any{"id": "provider-0", "name": "Fixture association", "issuer": business, "clientId": "z-last"}, map[string]any{"id": "provider-1", "name": "Fixture association", "issuer": business, "clientId": "a-first"}}})
	return result
}
