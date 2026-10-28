package servicemetadata

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestManifestSignerLifetimeAndCurrentTrust(t *testing.T) {
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, _ := x509.MarshalPKIXPublicKey(public)
	key := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	at := int64(2000000000)
	until := at + 1000
	pin := deviceauth.Pin{PublicKeyPEM: key, NotBefore: at - 1, NotAfter: at + 300, TrustedUntil: &until}
	signer := &deviceauth.SessionKeyring{Endpoint: "https://device.example.invalid", KID: "fixture", Key: private, Pins: func() map[string]deviceauth.Pin { return map[string]deviceauth.Pin{"fixture": pin} }}
	token, e := signer.SignManifest(context.Background(), map[string]any{"schemaVersion": 1}, at)
	if e != nil {
		t.Fatal(e)
	}
	parts := strings.Split(token, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		Iat, Exp int64
		JTI      string
	}
	_ = json.Unmarshal(raw, &claims)
	if claims.Iat != at || claims.Exp != at+300 || claims.JTI == "" {
		t.Fatal("manifest lifetime/id changed")
	}
	if _, e = signer.SignManifest(context.Background(), []string{"invalid"}, at); fault.Status(e) != 400 {
		t.Fatal("manifest accepted non-object data")
	}
	pin.NotAfter--
	if e = signer.AssertManifestAvailable(at); fault.Status(e) != 503 {
		t.Fatal("insufficient key lifetime accepted")
	}
	pin.NotAfter = at + 300
	pin.Revoked = true
	if e = signer.AssertManifestAvailable(at); fault.Status(e) != 503 {
		t.Fatal("revoked signer accepted")
	}
	pin.Revoked = false
	until = at
	if e = signer.AssertManifestAvailable(at); fault.Status(e) != 503 {
		t.Fatal("expired keyring trust accepted")
	}
	until = at + 1000
	pin.NotBefore = at + 1
	if e = signer.AssertManifestAvailable(at); fault.Status(e) != 503 {
		t.Fatal("future key accepted")
	}
}
