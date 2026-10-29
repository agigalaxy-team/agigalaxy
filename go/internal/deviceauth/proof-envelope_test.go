package deviceauth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
)

func TestProofPurposeEnvelopeAndCurrentPins(t *testing.T) {
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	publicPEM, _ := identity.PublicPEM(public)
	at := int64(2000000000)
	pin := Pin{PublicKeyPEM: publicPEM, NotBefore: at - 10, NotAfter: at + 100000}
	keyring := &SessionKeyring{Endpoint: "https://proof.example.invalid", KID: "synthetic-proof", Key: private, Pins: func() map[string]Pin { return map[string]Pin{"synthetic-proof": pin} }}
	data := map[string]any{"version": 1, "id": uuid.NewString(), "payloadHash": strings.Repeat("a", 64)}
	id := uuid.NewString()
	token, e := keyring.SignProof(context.Background(), data, id, at, 3600)
	if e != nil {
		t.Fatal(e)
	}
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(private)
	privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	input, _ := json.Marshal(map[string]any{"endpoint": keyring.Endpoint, "kid": keyring.KID, "data": data, "id": id, "at": at, "age": 3600, "publicKeyPem": publicPEM, "privateKeyPem": privatePEM, "token": token})
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/domain-envelope-contract.mjs"))
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(string(input))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("current proof envelope contract failed: %v", e)
	}
	var oracle struct {
		SameBytes bool
		Data      map[string]any
		ExpiresAt int64
	}
	if json.Unmarshal(out, &oracle) != nil || !oracle.SameBytes {
		t.Fatal("independent proof signature bytes differ")
	}
	raw, expires, e := keyring.VerifyProof(context.Background(), token, at)
	if e != nil || expires != at+3600 {
		t.Fatal("proof verification failed")
	}
	var opened map[string]any
	json.Unmarshal(raw, &opened)
	a, _ := identity.Canonical(opened)
	b, _ := identity.Canonical(oracle.Data)
	if string(a) != string(b) {
		t.Fatal("proof data differs")
	}
	if _, e = keyring.Verify(context.Background(), token, at); e == nil {
		t.Fatal("proof accepted as session challenge")
	}
	if _, e = keyring.SignProof(context.Background(), data, id, at, 86401); e == nil {
		t.Fatal("proof TTL broadened")
	}
	pin.Revoked = true
	if _, _, e = keyring.VerifyProof(context.Background(), token, at); e == nil {
		t.Fatal("revoked key proof accepted")
	}
	if _, e = keyring.SignProof(context.Background(), data, id, at, 3600); e == nil {
		t.Fatal("revoked key signed proof")
	}
}
