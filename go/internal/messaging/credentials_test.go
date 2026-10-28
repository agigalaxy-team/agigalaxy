package messaging

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestProtectedCredentialBindingRefreshAndNoPublicSecretProjection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "smtp-private.json")
	endpoint := "https://smtp.example.invalid"
	save := func(password string) {
		t.Helper()
		raw, _ := json.Marshal(Object{"version": 1, "endpoint": endpoint, "credentials": []any{Object{"ref": "synthetic-ref", "label": "Synthetic reference", "host": "smtp.example.invalid", "port": 465, "tls": "implicit", "purposes": []any{"notice"}, "user": "PRIVATE-SYNTHETIC-USER", "password": password}}})
		if e := os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	save("PRIVATE-PASSWORD-ONE")
	resolver, e := LoadCredentials(path, endpoint)
	if e != nil {
		t.Fatal(e)
	}
	selection := CredentialSelection{Ref: "synthetic-ref", Host: "smtp.example.invalid", Port: 465, TLS: "implicit", Purpose: "notice"}
	value, e := resolver.Resolve(selection)
	if e != nil || value == nil || value.Password != "PRIVATE-PASSWORD-ONE" {
		t.Fatal("reference resolution", e)
	}
	public, e := resolver.List()
	if e != nil || strings.Contains(encode(public), "PRIVATE-") {
		t.Fatal("credential public projection leaked")
	}
	wrong := selection
	wrong.Purpose = "team"
	if _, e = resolver.Resolve(wrong); fault.Code(e) != "smtp_credential_binding_mismatch" {
		t.Fatal("purpose binding ignored", e)
	}
	wrong = selection
	wrong.Host = "other.example.invalid"
	if _, e = resolver.Resolve(wrong); fault.Code(e) != "smtp_credential_binding_mismatch" {
		t.Fatal("host binding ignored", e)
	}
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		t.Skip("original refreshing resolver requires root-owned protected injection")
	}
	refreshing, e := NewRefreshingCredentials(path, endpoint)
	if e != nil {
		t.Fatal(e)
	}
	save("PRIVATE-PASSWORD-TWO")
	value, e = refreshing.Resolve(selection)
	if e != nil || value.Password != "PRIVATE-PASSWORD-TWO" {
		t.Fatal("old credential cached", e)
	}
	os.WriteFile(path, []byte(`{"bad":"PRIVATE"}`), 0600)
	if _, e = refreshing.Resolve(selection); fault.Code(e) != "system_settings_private_configuration_invalid" {
		t.Fatal("stale secret fallback", e)
	}
}
