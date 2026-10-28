package portal

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestOIDCRefreshVerifiesIssuerSubjectAndNeverProbesTokenTwice(t *testing.T) {
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	var base string
	var mode atomic.Int32
	var calls atomic.Int32
	b64 := base64.RawURLEncoding.EncodeToString
	sign := func(subject string) string {
		header, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "fixture", "typ": "JWT"})
		body, _ := json.Marshal(map[string]any{"iss": base, "sub": subject, "aud": "galaxy-fixture", "iat": time.Now().Unix(), "exp": time.Now().Unix() + 600})
		input := b64(header) + "." + b64(body)
		hash := sha256.Sum256([]byte(input))
		signature, e := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
		if e != nil {
			t.Fatal(e)
		}
		return input + "." + b64(signature)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": base, "authorization_endpoint": base + "/authorize", "token_endpoint": base + "/token", "jwks_uri": base + "/jwks", "code_challenge_methods_supported": []string{"S256"}, "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "fixture", "n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes())}}})
		case "/token":
			calls.Add(1)
			_ = r.ParseForm()
			if r.Method != "POST" || r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("client_id") != "galaxy-fixture" || r.Form.Get("refresh_token") != "fixture-refresh-token" {
				w.WriteHeader(400)
				return
			}
			if mode.Load() == 2 {
				w.WriteHeader(400)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
				return
			}
			if mode.Load() == 3 {
				w.WriteHeader(401)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid_client"})
				return
			}
			subject := "same-subject"
			if mode.Load() == 1 {
				subject = "different-subject"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access-token", "token_type": "Bearer", "refresh_token": "fixture-rotated-token", "expires_in": 600, "id_token": sign(subject)})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	base = server.URL
	provider, e := NewOIDC(context.Background(), OIDCConfig{Issuer: base, ClientID: "galaxy-fixture", AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	for _, test := range []struct {
		mode int32
		code string
	}{{0, ""}, {1, "portal_refresh_rejected"}, {2, "portal_refresh_rejected"}, {3, "portal_session_refresh_unconfirmed"}} {
		mode.Store(test.mode)
		before := calls.Load()
		tokens, e := provider.Refresh(context.Background(), RefreshRequest{Token: "fixture-refresh-token", Issuer: base, Subject: "same-subject"})
		if test.code == "" {
			if e != nil || tokens.RefreshToken != "fixture-rotated-token" {
				t.Fatalf("verified refresh failed: %v", e)
			}
		} else if fault.Code(e) != test.code {
			t.Fatalf("mode %d: want %s got %v", test.mode, test.code, e)
		}
		if calls.Load() != before+1 {
			t.Fatalf("mode %d retried token exchange", test.mode)
		}
	}
}
