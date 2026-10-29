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

func TestDomainEnvelopeBytesAndAgreementPins(t *testing.T) {
	ctx := context.Background()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicPEM, _ := identity.PublicPEM(public)
	const at int64 = 2000000000
	pin := Pin{PublicKeyPEM: publicPEM, NotBefore: at - 10, NotAfter: at + 100000}
	pins := map[string]Pin{"source-key": pin}
	k := &SessionKeyring{Endpoint: "https://source.example.invalid", KID: "source-key", Key: private, Pins: func() map[string]Pin { return pins }}
	data := map[string]any{"id": uuid.NewString(), "version": 1, "summary": "原字段 / bounded source"}
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(private)
	privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	root, _ := filepath.Abs("../../..")
	for _, kind := range []string{"node-control", "conformance", "hub-peering"} {
		t.Run(kind, func(t *testing.T) {
			id := uuid.NewString()
			var token string
			var err error
			if kind == "hub-peering" {
				token, err = k.SignHubPeering(ctx, data, id, at, 300)
			} else {
				token, err = k.SignConformance(ctx, kind, data, id, at, 300)
			}
			if err != nil {
				t.Fatal(err)
			}
			input, _ := json.Marshal(map[string]any{"endpoint": k.Endpoint, "kid": k.KID, "data": data, "id": id, "at": at, "age": 300, "publicKeyPem": publicPEM, "privateKeyPem": privatePEM, "token": token, "kind": kind})
			cmd := exec.Command("node", filepath.Join(root, "scripts/go/domain-envelope-contract.mjs"))
			cmd.Dir, cmd.Stdin = root, strings.NewReader(string(input))
			out, err := cmd.Output()
			var result struct {
				SameBytes bool
				ExpiresAt int64
			}
			if err != nil || json.Unmarshal(out, &result) != nil || !result.SameBytes || result.ExpiresAt != at+300 {
				t.Fatal("independent domain envelope differs", err)
			}
			if _, err = k.Verify(ctx, token, at); err == nil {
				t.Fatal("domain signature accepted as session")
			}
			if kind == "hub-peering" {
				opened, err := VerifyPeerEnvelope(ctx, token, kind, k.Endpoint, pins, at, 300)
				if err != nil || opened.ID != id || opened.ExpiresAt != at+300 || opened.IssuedAt != at {
					t.Fatal("agreement envelope unavailable", err)
				}
				if _, err = VerifyPeerEnvelope(ctx, token, kind, "https://other.example.invalid", pins, at, 300); err == nil {
					t.Fatal("wrong peer accepted")
				}
				if _, err = VerifyPeerEnvelope(ctx, token, kind, k.Endpoint, map[string]Pin{}, at, 300); err == nil {
					t.Fatal("ambient pins used")
				}
				if _, err = VerifyPeerEnvelope(ctx, token, kind, k.Endpoint, pins, at+300, 300); err == nil {
					t.Fatal("expired peer accepted")
				}
			}
		})
	}
	proof, err := k.SignProof(ctx, data, uuid.NewString(), at, 3600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = VerifyPeerEnvelope(ctx, proof, "proof", k.Endpoint, pins, at, 86400); err != nil {
		t.Fatal(err)
	}
	if _, err = VerifyPeerEnvelope(ctx, proof, "hub-peering", k.Endpoint, pins, at, 300); err == nil {
		t.Fatal("proof elevated to agreement")
	}
	if _, err = k.SignConformance(ctx, "proof", data, "id", at, 300); err == nil {
		t.Fatal("arbitrary signing purpose")
	}
	if _, err = k.SignConformance(ctx, "conformance", data, "id", at, 301); err == nil {
		t.Fatal("extended portable TTL")
	}
	pin.Revoked = true
	pins[k.KID] = pin
	if _, err = k.SignHubPeering(ctx, data, "id", at, 300); err == nil {
		t.Fatal("revoked signer")
	}
	if _, err = VerifyPeerEnvelope(ctx, proof, "proof", k.Endpoint, pins, at, 86400); err == nil {
		t.Fatal("revoked agreement proof key")
	}
}
