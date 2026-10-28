package portal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Policy struct {
	Key                                               []byte
	IdleSeconds, MaximumSeconds, RefreshBeforeSeconds int64
}

func (p Policy) Validate() error {
	if len(p.Key) != 32 || p.IdleSeconds < 60 || p.MaximumSeconds < p.IdleSeconds || p.MaximumSeconds > 31536000 || p.RefreshBeforeSeconds < 0 || p.RefreshBeforeSeconds > 300 {
		return fault.New("portal_policy_invalid", 400)
	}
	return nil
}
func LoadPolicy(keyFile string, idle, maximum, before int64) (Policy, error) {
	p := Policy{IdleSeconds: idle, MaximumSeconds: maximum, RefreshBeforeSeconds: before}
	if !filepath.IsAbs(keyFile) {
		return p, fault.New("portal_policy_invalid", 400)
	}
	info, e := os.Lstat(keyFile)
	if e != nil || !info.Mode().IsRegular() || info.Size() > 256 {
		return p, fault.New("portal_policy_invalid", 400)
	}
	b, e := os.ReadFile(keyFile)
	if e != nil {
		return p, fault.New("portal_policy_unavailable", 503)
	}
	s := strings.TrimSpace(string(b))
	if len(s) != 43 {
		return p, fault.New("portal_policy_invalid", 400)
	}
	p.Key, e = base64.RawURLEncoding.DecodeString(s)
	if e != nil {
		return p, fault.New("portal_policy_invalid", 400)
	}
	return p, p.Validate()
}
func (s *Sessions) aead() (cipher.AEAD, error) {
	block, e := aes.NewCipher(s.Policy.Key)
	if e != nil {
		return nil, fault.New("portal_policy_invalid", 400)
	}
	return cipher.NewGCM(block)
}
func (s *Sessions) aad(hash string) ([]byte, error) {
	fields := []string{s.Kind}
	fields = append(fields, s.Scope...)
	fields = append(fields, hash)
	return protocol.Encode(fields)
}

// Cipher layout exactly matches the existing Node portal: IV(12), ciphertext,
// GCM tag(16), with JSON [kind,...scope,tokenHash] authenticated as AAD.
func (s *Sessions) Encrypt(value, hash string) (string, error) {
	a, e := s.aead()
	if e != nil {
		return "", e
	}
	aad, e := s.aad(hash)
	if e != nil {
		return "", e
	}
	iv := make([]byte, a.NonceSize())
	if _, e = rand.Read(iv); e != nil {
		return "", e
	}
	sealed := a.Seal(iv, iv, []byte(value), aad)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}
func (s *Sessions) Decrypt(value, hash string) (string, error) {
	data, e := base64.RawURLEncoding.DecodeString(value)
	if e != nil {
		return "", fault.New("portal_session_cipher_invalid", 503)
	}
	a, e := s.aead()
	if e != nil {
		return "", e
	}
	if len(data) < a.NonceSize()+a.Overhead() {
		return "", fault.New("portal_session_cipher_invalid", 503)
	}
	aad, e := s.aad(hash)
	if e != nil {
		return "", e
	}
	out, e := a.Open(nil, data[:a.NonceSize()], data[a.NonceSize():], aad)
	if e != nil {
		return "", fault.New("portal_session_cipher_invalid", 503)
	}
	return string(out), nil
}
