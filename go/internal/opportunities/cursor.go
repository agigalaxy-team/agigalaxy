package opportunities

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (s *Service) cursorCipher() (cipher.AEAD, error) {
	s.cursorOnce.Do(func() { s.cursorKey = make([]byte, 32); _, s.cursorError = rand.Read(s.cursorKey) })
	if s.cursorError != nil {
		return nil, s.cursorError
	}
	block, e := aes.NewCipher(s.cursorKey)
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(block)
}
func (s *Service) SealCursor(input Object) (string, error) {
	a, e := s.cursorCipher()
	if e != nil {
		return "", e
	}
	iv := make([]byte, 12)
	if _, e = rand.Read(iv); e != nil {
		return "", e
	}
	value := Object{}
	for k, v := range input {
		value[k] = v
	}
	value["expiresAt"] = s.now() + 900
	sealed := a.Seal(nil, iv, encode(value), []byte("galaxy-discovery-v2"))
	raw := append(iv, sealed[len(sealed)-16:]...)
	raw = append(raw, sealed[:len(sealed)-16]...)
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
func (s *Service) OpenCursor(input, hash, viewer string) (Object, error) {
	no := func() (Object, error) { return nil, fail("discovery_cursor_unavailable_restart", 409) }
	raw, e := base64.RawURLEncoding.DecodeString(input)
	if e != nil || base64.RawURLEncoding.EncodeToString(raw) != input || len(raw) < 29 {
		return no()
	}
	a, e := s.cursorCipher()
	if e != nil {
		return nil, e
	}
	sealed := append(append([]byte{}, raw[28:]...), raw[12:28]...)
	plain, e := a.Open(nil, raw[:12], sealed, []byte("galaxy-discovery-v2"))
	if e != nil {
		return no()
	}
	var value Object
	if protocol.Decode(plain, &value) != nil || value == nil || number(value["v"]) != 2 || str(value, "queryHash") != hash || value["viewerId"] != nullable(viewer) || number(value["expiresAt"]) <= s.now() {
		return no()
	}
	return value, nil
}
func OpportunityID(ref Object) string {
	keys := []string{"subjectId", "projectId", "statementId"}
	switch str(ref, "sourceKind") {
	case "project":
		keys = []string{"sourceKind", "subjectId", "projectId", "documentEventId", "policyEventId"}
	case "recruitment":
		keys = []string{"sourceKind", "subjectId", "projectId", "recruitmentId", "eventId"}
	}
	raw := []byte{'{'}
	for _, key := range keys {
		if len(raw) > 1 {
			raw = append(raw, ',')
		}
		raw = append(raw, encode(key)...)
		raw = append(raw, ':')
		raw = append(raw, encode(ref[key])...)
	}
	return identity.Digest(append(raw, '}'))
}
