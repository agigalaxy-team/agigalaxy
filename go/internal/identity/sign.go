package identity

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
)

func Digest(data []byte) string { s := sha256.Sum256(data); return hex.EncodeToString(s[:]) }
func Canonical(v any) ([]byte, error) {
	b, e := protocol.Encode(v)
	if e != nil {
		return nil, e
	}
	return jsoncanonicalizer.Transform(b)
}
func PrivatePEM(data []byte) (ed25519.PrivateKey, error) {
	b, rest := pem.Decode(data)
	if b == nil || b.Type != "PRIVATE KEY" || len(rest) > 0 {
		return nil, errors.New("native_key_invalid")
	}
	v, e := x509.ParsePKCS8PrivateKey(b.Bytes)
	if e != nil {
		return nil, errors.New("native_key_invalid")
	}
	key, ok := v.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("native_key_invalid")
	}
	return key, nil
}
func PublicPEM(key ed25519.PublicKey) (string, error) {
	b, e := x509.MarshalPKIXPublicKey(key)
	if e != nil {
		return "", e
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: b})), nil
}

// Identity protocol signs the caller's exact UTF-8 payload, not a reserialized map.
func SignIdentityPayload(key ed25519.PrivateKey, payloadText, kind string) (string, error) {
	if kind == "" {
		kind = "galaxy-identity-control-v2+jws"
	}
	header, e := protocol.Encode(struct {
		Alg  string `json:"alg"`
		Type string `json:"typ"`
	}{"Ed25519", kind})
	if e != nil {
		return "", e
	}
	b64 := base64.RawURLEncoding.EncodeToString
	input := b64(header) + "." + b64([]byte(payloadText))
	return input + "." + b64(ed25519.Sign(key, []byte(input))), nil
}
