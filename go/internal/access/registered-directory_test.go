package access

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRegisteredDirectoryKeepsIndependentReadonlyWorker(t *testing.T) {
	dir := t.TempDir()
	reader := filepath.Join(dir, "reader.json")
	writer := filepath.Join(dir, "writer.json")
	config := filepath.Join(dir, "operations.json")
	save := func(path string, value any) {
		t.Helper()
		b, _ := json.Marshal(value)
		if e := os.WriteFile(path, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	save(reader, map[string]any{"version": 1, "clientId": "website-reader", "clientSecret": "isolated-reader"})
	issuer := "https://website.example.invalid/realms/website"
	ref := map[string]any{"issuer": issuer, "credentialFile": reader, "writerCredentialFile": writer}
	body := map[string]any{"version": 1, "issuer": "https://management.example.invalid/realms/management", "accountDirectory": ref}
	save(config, body)
	n, e := LoadRegisteredDirectory(config, false, issuer)
	if e != nil || n == nil || n.ManagementConfigured() {
		t.Fatalf("read-only worker loaded unavailable writer %v", e)
	}
	if _, e = LoadRegisteredDirectory(config, true, issuer); e == nil {
		t.Fatal("writer enabled without independent credential")
	}
	save(writer, map[string]any{"version": 1, "clientId": "website-writer", "clientSecret": "isolated-writer"})
	n, e = LoadRegisteredDirectory(config, true, issuer)
	if e != nil || n == nil || !n.ManagementConfigured() {
		t.Fatalf("explicit API writer unavailable %v", e)
	}
	if _, e = LoadRegisteredDirectory(config, true, "https://other.example.invalid/realms/website"); e == nil {
		t.Fatal("unexpected website issuer accepted")
	}
	ref["writerCredentialFile"] = reader
	save(config, body)
	if _, e = LoadRegisteredDirectory(config, false, issuer); e == nil {
		t.Fatal("shared writer path accepted even in reader configuration")
	}
	delete(ref, "writerCredentialFile")
	ref["extra"] = true
	save(config, body)
	if _, e = LoadRegisteredDirectory(config, false, issuer); e == nil {
		t.Fatal("unknown directory reference key accepted")
	}
	if n, e = LoadRegisteredDirectory("", true, issuer); e != nil || n != nil {
		t.Fatalf("absent optional directory %v", e)
	}
}
