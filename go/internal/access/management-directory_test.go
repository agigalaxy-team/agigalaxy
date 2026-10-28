package access

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestManagementDirectoryProtectedReaderWriterReferences(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, v any) string {
		t.Helper()
		path := filepath.Join(dir, name)
		b, _ := json.Marshal(v)
		if e := os.WriteFile(path, b, 0600); e != nil {
			t.Fatal(e)
		}
		return path
	}
	credential := func(id string) map[string]any {
		return map[string]any{"version": 1, "clientId": id, "clientSecret": "isolated-local-secret"}
	}
	reader := write("reader.json", credential("management-reader"))
	business := write("business.json", credential("business-reader"))
	writer := write("writer.json", credential("galaxy-management-account-maintenance"))
	businessWriter := filepath.Join(dir, "unread-business-writer.json")
	config := func() map[string]any {
		return map[string]any{"version": 1, "adminOrigin": "https://admin.example.invalid", "issuer": "https://management.example.invalid/realms/galaxy-operations", "clientId": "portal", "directoryCredentialFile": reader, "roles": map[string]any{"administrator": "galaxy-operations-administrator", "reader": "galaxy-operations-reader"}, "accountDirectory": map[string]any{"issuer": "https://public.example.invalid/realms/public", "credentialFile": business, "writerCredentialFile": businessWriter}, "rootOperatorFile": filepath.Join(dir, "unread-root.json"), "managementAccounts": map[string]any{"writerCredentialFile": writer}}
	}
	path := write("operations.json", config())
	native, e := LoadManagementDirectory(path)
	if e != nil || native == nil || !native.ManagementConfigured() || !native.EmailChangeConfigured() {
		t.Fatalf("protected management load %v", e)
	}
	// A business writer reference and protected root are not read by this adapter.
	if _, e := os.Stat(businessWriter); !os.IsNotExist(e) {
		t.Fatal("test business writer unexpectedly exists")
	}
	readOnly := config()
	delete(readOnly, "managementAccounts")
	native, e = LoadManagementDirectory(write("readonly.json", readOnly))
	if e != nil || native.ManagementConfigured() || native.EmailChangeConfigured() {
		t.Fatalf("read-only configuration %v", e)
	}
	for _, patch := range []map[string]any{{"managementAccounts": map[string]any{"writerCredentialFile": reader}}, {"managementAccounts": map[string]any{"writerCredentialFile": business}}, {"managementAccounts": map[string]any{"writerCredentialFile": businessWriter}}, {"managementAccounts": map[string]any{"writerCredentialFile": writer, "unexpected": true}}, {"managementAccounts": map[string]any{"writerCredentialFile": "relative.json"}}, {"roles": map[string]any{}}, {"unrecognized": true}} {
		c := config()
		for k, v := range patch {
			c[k] = v
		}
		if _, e := LoadManagementDirectory(write("invalid.json", c)); e == nil {
			t.Fatal("invalid protected references accepted")
		}
	}
	if _, e := LoadManagementDirectory("relative.json"); e == nil {
		t.Fatal("relative configuration accepted")
	}
	if n, e := LoadManagementDirectory(""); e != nil || n != nil {
		t.Fatal("absent configuration changed")
	}
}
