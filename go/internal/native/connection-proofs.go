package native

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

type connectionEnvelope struct {
	Data                map[string]any
	ID                  string
	IssuedAt, ExpiresAt int64
}

var connectionUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var connectionHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func connectionFailure(code string) error { return fault.New(code, 409) }
func connectionExact(v map[string]any, keys ...string) bool {
	if v == nil || len(v) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := v[key]; !ok {
			return false
		}
	}
	return true
}
func connectionPublicPEM(value string) (ed25519.PublicKey, error) {
	block, rest := pem.Decode([]byte(value))
	if block == nil || block.Type != "PUBLIC KEY" || uploadTrim(string(rest)) != "" {
		return nil, connectionFailure("native_server_proof_invalid")
	}
	key, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return nil, connectionFailure("native_server_proof_invalid")
	}
	public, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, connectionFailure("native_server_proof_invalid")
	}
	return public, nil
}
func connectionObject(raw []byte) (map[string]any, error) {
	var out map[string]any
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	if e := d.Decode(&out); e != nil || out == nil {
		return nil, connectionFailure("native_server_proof_invalid")
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		return nil, connectionFailure("native_server_proof_invalid")
	}
	return out, nil
}
func connectionSigned(token string) (map[string]any, map[string]any, []byte, string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, nil, nil, "", connectionFailure("native_server_proof_invalid")
	}
	h, e := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if e != nil {
		return nil, nil, nil, "", connectionFailure("native_server_proof_invalid")
	}
	b, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil {
		return nil, nil, nil, "", connectionFailure("native_server_proof_invalid")
	}
	signature, e := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	if e != nil {
		return nil, nil, nil, "", connectionFailure("native_server_proof_invalid")
	}
	header, e := connectionObject(h)
	if e != nil {
		return nil, nil, nil, "", e
	}
	payload, e := connectionObject(b)
	return header, payload, signature, parts[0] + "." + parts[1], e
}
func (c *Connection) envelope(token, kind string, maxAge int64) (connectionEnvelope, error) {
	var out connectionEnvelope
	if len(token) > 65536 {
		return out, connectionFailure("native_server_proof_invalid")
	}
	header, payload, signature, input, e := connectionSigned(token)
	if e != nil {
		return out, e
	}
	if !connectionExact(header, "alg", "kid", "typ") || header["alg"] != "Ed25519" || header["typ"] != "galaxy-"+kind+"+jwt" {
		return out, connectionFailure("native_server_proof_invalid")
	}
	pin, ok := c.config.TrustedKeys[text(header["kid"])]
	now := c.now().Unix()
	if !ok || pin.Revoked || now < pin.NotBefore || now >= pin.NotAfter || pin.TrustedUntil != nil && now >= *pin.TrustedUntil {
		return out, connectionFailure("native_server_pin_invalid")
	}
	key, e := connectionPublicPEM(pin.PublicKeyPEM)
	if e != nil || !ed25519.Verify(key, []byte(input), signature) {
		return out, connectionFailure("native_server_signature_invalid")
	}
	if !connectionExact(payload, "aud", "data", "exp", "iat", "iss", "jti", "nbf") || payload["aud"] != c.config.Endpoint || payload["iss"] != c.config.Endpoint {
		return out, connectionFailure("native_server_proof_invalid")
	}
	iat, exp, nbf := integer(payload["iat"]), integer(payload["exp"]), integer(payload["nbf"])
	if !connectionSafeInteger(payload["iat"]) || !connectionSafeInteger(payload["exp"]) || !connectionSafeInteger(payload["nbf"]) || nbf != iat || exp <= iat || exp-iat > maxAge || iat < pin.NotBefore || exp > pin.NotAfter || now >= exp || now-iat > maxAge {
		return out, connectionFailure("native_server_proof_expired")
	}
	if nbf > now {
		return out, &connectionNotBefore{nbf}
	}
	id := text(payload["jti"])
	data, ok := payload["data"].(map[string]any)
	if id == "" || len(id) > 128 || !ok {
		return out, connectionFailure("native_server_proof_invalid")
	}
	return connectionEnvelope{data, id, iat, exp}, nil
}

type connectionNotBefore struct{ second int64 }

func (e *connectionNotBefore) Error() string { return "native_server_proof_not_yet_valid" }
func connectionSafeInteger(v any) bool {
	n, ok := v.(json.Number)
	if !ok {
		return false
	}
	i, e := n.Int64()
	return e == nil && i >= 0 && i <= 9007199254740991
}
func connectionEqual(a, b any) bool {
	normalize := func(v any) any { b, _ := json.Marshal(v); var x any; _ = json.Unmarshal(b, &x); return x }
	return reflect.DeepEqual(normalize(a), normalize(b))
}
func connectionStrings(v any) ([]string, bool) {
	a, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, len(a))
	for i, v := range a {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		out[i] = s
	}
	return out, true
}
func connectionCredential(v any) bool {
	s, ok := v.(string)
	if !ok || len(s) != 43 {
		return false
	}
	b, e := base64.RawURLEncoding.Strict().DecodeString(s)
	return e == nil && len(b) == 32
}
func connectionISO(value string) (string, error) {
	t, e := time.Parse(time.RFC3339Nano, value)
	if e != nil {
		return "", connectionFailure("native_control_history_invalid")
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}
func connectionVerifyJWS(token, pemText, payloadText, kind string) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > 24000 {
		return connectionFailure("native_control_signature_invalid")
	}
	h, e := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if e != nil {
		return connectionFailure("native_control_signature_invalid")
	}
	header, e := connectionObject(h)
	if e != nil || !connectionExact(header, "alg", "typ") || header["alg"] != "Ed25519" || header["typ"] != kind {
		return connectionFailure("native_control_signature_invalid")
	}
	body, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil || string(body) != payloadText {
		return connectionFailure("native_control_signature_invalid")
	}
	signature, e := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	key, keyError := connectionPublicPEM(pemText)
	if e != nil || keyError != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return connectionFailure("native_control_signature_invalid")
	}
	return nil
}
func connectionCanonicalHash(v any) (string, error) {
	raw, e := identity.Canonical(v)
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
