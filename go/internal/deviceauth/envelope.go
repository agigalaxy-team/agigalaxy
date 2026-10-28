// Package deviceauth retains the existing binding-bound short credential handshake.
// Portal account cookies never enter this authority.
package deviceauth

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"

	"net/url"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Pin struct {
	PublicKeyPEM        string
	NotBefore, NotAfter int64
	TrustedUntil        *int64
	Revoked             bool
}

// SessionSigner exposes only this handshake purpose; private key ownership stays
// with its configured implementation, and pins are checked again on every use.
type SessionSigner interface {
	Sign(context.Context, Challenge, string, int64) (string, error)
	Verify(context.Context, string, int64) (Opened, error)
}
type SessionKeyring struct {
	Endpoint, KID  string
	Key            ed25519.PrivateKey
	Pins           func() map[string]Pin
	publicDocument json.RawMessage
	publicOrder    []string
	trustSequence  int64
}

func (k *SessionKeyring) TrustSequence() int64 { return k.trustSequence }

type Challenge struct {
	BindingID           string   `json:"bindingId"`
	CredentialHash      string   `json:"credentialHash"`
	Purpose             string   `json:"purpose"`
	Scopes              []string `json:"scopes"`
	CredentialExpiresAt int64    `json:"credentialExpiresAt"`
}
type Opened struct {
	Data Challenge
	ID   string
}

func denied() error { return fault.New("access_denied", 401) }
func parsePublic(value string) (ed25519.PublicKey, error) {
	b, rest := pem.Decode([]byte(value))
	if b == nil || b.Type != "PUBLIC KEY" || len(rest) != 0 {
		return nil, denied()
	}
	v, e := x509.ParsePKIXPublicKey(b.Bytes)
	if e != nil {
		return nil, denied()
	}
	key, ok := v.(ed25519.PublicKey)
	if !ok {
		return nil, denied()
	}
	return key, nil
}
func exactJSON(raw []byte, keys ...string) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || len(m) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return false
		}
	}
	return true
}
func (k *SessionKeyring) pin(id string, at int64) (Pin, error) {
	if k.Pins == nil {
		return Pin{}, denied()
	}
	p, ok := k.Pins()[id]
	if !ok || p.Revoked || at < p.NotBefore || at >= p.NotAfter || p.TrustedUntil != nil && at >= *p.TrustedUntil {
		return Pin{}, denied()
	}
	return p, nil
}
func (k *SessionKeyring) Sign(ctx context.Context, data Challenge, id string, at int64) (string, error) {
	return k.signEnvelope("session-challenge", data, id, at, 120)
}
func (k *SessionKeyring) signEnvelope(kind string, data any, id string, at, age int64) (string, error) {
	if kind != "proof" && kind != "manifest" && kind != "session-challenge" && kind != "binding-challenge" && kind != "binding-receipt" && kind != "receipt-status-challenge" && kind != "node-control" && kind != "conformance" && kind != "hub-peering" {
		return "", fault.New("signing_purpose_denied", 403)
	}
	p, e := k.pin(k.KID, at)
	u, ue := url.Parse(k.Endpoint)
	if e != nil || p.NotAfter < at+age || age < 1 || age > 86400 || len(k.Key) != ed25519.PrivateKeySize || ue != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fault.New("signing_unavailable", 503)
	}
	public, e := parsePublic(p.PublicKeyPEM)
	if e != nil || !public.Equal(k.Key.Public()) {
		return "", fault.New("signing_unavailable", 503)
	}
	header, e := protocol.Encode(struct {
		Alg  string `json:"alg"`
		Type string `json:"typ"`
		KID  string `json:"kid"`
	}{"Ed25519", "galaxy-" + kind + "+jwt", k.KID})
	if e != nil {
		return "", e
	}
	payload, e := protocol.Encode(struct {
		Data      any    `json:"data"`
		Issuer    string `json:"iss"`
		Audience  string `json:"aud"`
		Issued    int64  `json:"iat"`
		NotBefore int64  `json:"nbf"`
		Expires   int64  `json:"exp"`
		ID        string `json:"jti"`
	}{data, k.Endpoint, k.Endpoint, at, at, at + age, id})
	if e != nil {
		return "", e
	}
	b64 := base64.RawURLEncoding.EncodeToString
	input := b64(header) + "." + b64(payload)
	token := input + "." + b64(ed25519.Sign(k.Key, []byte(input)))
	if len(token) > 65536 {
		return "", fault.New("signing_unavailable", 503)
	}
	return token, nil
}
func splitCompact(token string) ([]byte, []byte, []byte, string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, nil, nil, "", denied()
	}
	values := make([][]byte, 3)
	for i, p := range parts {
		b, e := base64.RawURLEncoding.Strict().DecodeString(p)
		if e != nil {
			return nil, nil, nil, "", denied()
		}
		values[i] = b
	}
	return values[0], values[1], values[2], parts[0] + "." + parts[1], nil
}

type envelope struct {
	Data                json.RawMessage
	ID                  string
	IssuedAt, ExpiresAt int64
}

func (k *SessionKeyring) Verify(ctx context.Context, token string, at int64) (Opened, error) {
	v, e := k.verifyEnvelope(token, "session-challenge", 120, at)
	if e != nil {
		return Opened{}, e
	}
	var c Challenge
	if json.Unmarshal(v.Data, &c) != nil {
		return Opened{}, denied()
	}
	return Opened{c, v.ID}, nil
}
func (k *SessionKeyring) verifyEnvelope(token, kind string, maxAge, at int64) (envelope, error) {
	var empty envelope
	if len(token) > 65536 {
		return empty, denied()
	}
	h, b, s, input, e := splitCompact(token)
	if e != nil || !exactJSON(h, "alg", "typ", "kid") || !exactJSON(b, "data", "iss", "aud", "iat", "nbf", "exp", "jti") {
		return empty, denied()
	}
	var header struct{ Alg, Typ, KID string }
	var claims struct {
		Data          json.RawMessage
		Iss, Aud, JTI string
		Iat, Nbf, Exp int64
	}
	if json.Unmarshal(h, &header) != nil || json.Unmarshal(b, &claims) != nil || header.Alg != "Ed25519" || header.Typ != "galaxy-"+kind+"+jwt" || claims.Iss != k.Endpoint || claims.Aud != k.Endpoint || claims.JTI == "" || protocol.TextLength(claims.JTI) > 128 || claims.Nbf != claims.Iat || claims.Iat > at || claims.Exp <= at || claims.Exp <= claims.Iat || claims.Exp-claims.Iat > maxAge || at-claims.Iat > maxAge {
		return empty, denied()
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(claims.Data, &object) != nil || object == nil {
		return empty, denied()
	}
	p, e := k.pin(header.KID, at)
	if e != nil || claims.Iat < p.NotBefore || claims.Exp > p.NotAfter {
		return empty, denied()
	}
	public, e := parsePublic(p.PublicKeyPEM)
	if e != nil || !ed25519.Verify(public, []byte(input), s) {
		return empty, denied()
	}
	return envelope{claims.Data, claims.JTI, claims.Iat, claims.Exp}, nil
}
func VerifyResponse(token, payload, publicKey string) error {
	return verifyTypedResponse(token, payload, publicKey, "galaxy-session-response+jws")
}
func verifyTypedResponse(token, payload, publicKey, kind string) error {
	h, b, s, input, e := splitCompact(token)
	if e != nil || !exactJSON(h, "alg", "typ") {
		return denied()
	}
	var header struct{ Alg, Typ string }
	if json.Unmarshal(h, &header) != nil || header.Alg != "Ed25519" || header.Typ != kind || string(b) != payload {
		return denied()
	}
	key, e := parsePublic(publicKey)
	if e != nil || !ed25519.Verify(key, []byte(input), s) {
		return denied()
	}
	return nil
}
