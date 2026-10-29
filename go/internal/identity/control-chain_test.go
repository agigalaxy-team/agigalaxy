package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestPortableTrustFixedPurposes(t *testing.T) {
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	public, _ := PublicPEM(pub)
	// Full packages have their own bounded schema and can exceed a control event.
	payload := "{\n\"text\":\"" + strings.Repeat("synthetic", 4000) + "\"}\n"
	token, _ := SignIdentityPayload(key, payload, "galaxy-trust-package-v1+jws")
	if e = VerifyTrustPackageSignature(token, public, payload); e != nil {
		t.Fatal(e)
	}
	consent, _ := SignIdentityPayload(key, " {\"consent\":true} \n", "galaxy-consent+jws")
	text, e := OpenTrustConsentSignature(consent, public)
	if e != nil || text != " {\"consent\":true} \n" {
		t.Fatal("exact consent text", e)
	}
	if _, e = OpenTrustConsentSignature(token, public); e == nil {
		t.Fatal("package accepted as consent")
	}
	if e = VerifyTrustPackageSignature(consent, public, " {\"consent\":true} \n"); e == nil {
		t.Fatal("consent accepted as package")
	}
	invalid, _ := SignIdentityPayload(key, string([]byte{0xff}), "galaxy-consent+jws")
	if _, e = OpenTrustConsentSignature(invalid, public); e == nil {
		t.Fatal("invalid UTF8 consent")
	}
}

// Captured original verifier vectors contain only synthetic public keys and signed events.
func TestControlChainOriginalInterop(t *testing.T) {
	raw, e := os.ReadFile("testdata/control-chain-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var samples []struct {
		Name     string
		Input    json.RawMessage
		Expected json.RawMessage
		Invalid  bool
	}
	if e = json.Unmarshal(raw, &samples); e != nil {
		t.Fatal(e)
	}
	for _, s := range samples {
		t.Run(s.Name, func(t *testing.T) {
			out, e := VerifyControlChain(s.Input)
			if s.Invalid {
				if e == nil {
					t.Fatal("accepted original refusal")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			got, _ := json.Marshal(out)
			var a, b any
			_ = json.Unmarshal(got, &a)
			_ = json.Unmarshal(s.Expected, &b)
			aa, _ := json.Marshal(a)
			bb, _ := json.Marshal(b)
			if string(aa) != string(bb) {
				t.Fatalf("shared=%s original=%s", aa, bb)
			}
		})
	}
}
