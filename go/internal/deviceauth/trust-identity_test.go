package deviceauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"testing"
)

func TestTrustPermissionFixedPurposeAndOriginalText(t *testing.T) {
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	pem, _ := identity.PublicPEM(pub)
	raw := "{\n  \"subjectId\": \"isolated\", \"message\": \"原字节\"\n}\n"
	token, e := identity.SignIdentityPayload(key, raw, "galaxy-trust-source-permission-v1+jws")
	if e != nil {
		t.Fatal(e)
	}
	got, e := VerifyTrustPermissionResponse(token, pem)
	if e != nil || got != raw {
		t.Fatalf("exact text refused: %v", e)
	}
	for _, kind := range []string{"galaxy-session-response+jws", "galaxy-identity-control-v2+jws"} {
		x, _ := identity.SignIdentityPayload(key, raw, kind)
		if _, e = VerifyTrustPermissionResponse(x, pem); e == nil {
			t.Fatalf("accepted purpose %s", kind)
		}
	}
	x, _ := identity.SignIdentityPayload(key, string([]byte{0xff}), "galaxy-trust-source-permission-v1+jws")
	if _, e = VerifyTrustPermissionResponse(x, pem); e == nil {
		t.Fatal("accepted non UTF-8 signed payload")
	}
}
