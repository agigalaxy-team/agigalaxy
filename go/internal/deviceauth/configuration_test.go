package deviceauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

func TestProtectedTrustConfigurationRejectsMissingTypesAndUnsafeFiles(t *testing.T) {
	public, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	pem, e := identity.PublicPEM(public)
	if e != nil {
		t.Fatal(e)
	}
	key := map[string]any{"kid": "service", "publicKeyPem": pem, "notBefore": int64(1), "notAfter": int64(100000), "revoked": false}
	data := map[string]any{"version": 1, "endpoint": "https://example.invalid", "sequence": 1, "keys": []any{key}}
	raw, _ := json.Marshal(data)
	if _, _, e = validateKeys(raw, "https://example.invalid"); e != nil {
		t.Fatal(e)
	}
	for _, field := range []string{"notBefore", "revoked"} {
		previous := key[field]
		key[field] = nil
		raw, _ = json.Marshal(data)
		if _, _, e = validateKeys(raw, "https://example.invalid"); e == nil {
			t.Errorf("null %s accepted", field)
		}
		key[field] = previous
	}
	file := filepath.Join(t.TempDir(), "public.json")
	if e = os.WriteFile(file, []byte("12345"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = configurationRead(file, 4, false); e == nil {
		t.Fatal("oversize file accepted")
	}
	if _, e = configurationRead("relative.json", 4096, true); e == nil {
		t.Fatal("relative secret path accepted")
	}
	if _, e = configurationRead(filepath.Dir(file), 4096, false); e == nil {
		t.Fatal("directory accepted as keyring")
	}
}
