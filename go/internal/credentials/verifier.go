package credentials

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	jose "github.com/go-jose/go-jose/v4"
)

func reject(code string) error      { return fault.New(code, 422) }
func str(v any) string              { s, _ := v.(string); return s }
func object(v any) Object           { m, _ := v.(map[string]any); return m }
func has(o Object, key string) bool { _, ok := o[key]; return ok }
func validText(v any, max int) bool { s, ok := v.(string); return ok && plain(s, max) }
func iso(t time.Time) string {
	t = t.UTC()
	year := fmt.Sprintf("%04d", t.Year())
	if t.Year() < 0 || t.Year() > 9999 {
		year = fmt.Sprintf("%+07d", t.Year())
	}
	return year + "-" + t.Format("01-02T15:04:05.000Z")
}
func timestamp(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok {
		return time.Time{}, false
	}
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil && len(s) > 7 && (s[0] == '+' || s[0] == '-') && s[7] == '-' {
		year, parse := strconv.Atoi(s[:7])
		base, rest := time.Parse(time.RFC3339Nano, "2000"+s[7:])
		if parse == nil && rest == nil {
			t = time.Date(year, base.Month(), base.Day(), base.Hour(), base.Minute(), base.Second(), base.Nanosecond(), base.Location())
			e = nil
		}
	}
	return t, e == nil
}

var datePattern = regexp.MustCompile(`^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$`)

func dateField(o Object, key string) (*int64, error) {
	v, ok := o[key]
	if !ok {
		return nil, nil
	}
	s, ok := v.(string)
	match := datePattern.FindStringSubmatch(s)
	if !ok || match == nil {
		return nil, reject("external_credential_format_invalid")
	}
	value := func(index int) int { n, _ := strconv.Atoi(match[index]); return n }
	year, month, day, hour, minute, second := value(1), value(2), value(3), value(4), value(5), value(6)
	// Date.parse accepts ISO days through 31 and normalizes calendar overflow,
	// and accepts exactly 24:00. Keep that original behavior before flooring.
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59 || hour == 24 && (minute != 0 || second != 0 || strings.Trim(match[7], "0") != "") {
		return nil, reject("external_credential_format_invalid")
	}
	offset := 0
	if match[8] != "Z" {
		hours, _ := strconv.Atoi(match[8][1:3])
		minutes, _ := strconv.Atoi(match[8][4:6])
		if hours > 23 || minutes > 59 {
			return nil, reject("external_credential_format_invalid")
		}
		offset = hours*3600 + minutes*60
		if match[8][0] == '-' {
			offset = -offset
		}
	}
	t := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.FixedZone("", offset))
	n := t.Unix()
	return &n, nil
}
func numericField(o Object, key string) (*int64, error) {
	v, ok := o[key]
	if !ok {
		return nil, nil
	}
	n, ok := v.(float64)
	if !ok || n != math.Trunc(n) || n < 0 || n > 253402300799 {
		return nil, reject("external_credential_format_invalid")
	}
	value := int64(n)
	return &value, nil
}
func isoSeconds(v *int64) any {
	if v == nil {
		return nil
	}
	return iso(time.Unix(*v, 0))
}
func tokenParts(token string, max int) (Object, Object, error) {
	if len(token) > max {
		return nil, nil, reject("external_credential_too_large")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, nil, reject("external_credential_format_invalid")
	}
	decode := func(part string) (Object, error) {
		b, e := base64.RawURLEncoding.DecodeString(part)
		if e != nil || !utf8.Valid(b) {
			return nil, reject("external_credential_format_invalid")
		}
		var o Object
		if json.Unmarshal(b, &o) != nil || o == nil {
			return nil, reject("external_credential_format_invalid")
		}
		return o, nil
	}
	h, e := decode(parts[0])
	if e != nil {
		return nil, nil, e
	}
	if _, ok := h["alg"].(string); !ok {
		return nil, nil, reject("external_credential_signature_unsupported")
	}
	kid, ok := h["kid"].(string)
	if !ok || kid == "" || protocol.TextLength(kid) > 200 {
		return nil, nil, reject("external_credential_signature_unsupported")
	}
	for _, key := range []string{"jku", "jwk", "x5u", "x5c", "crit", "b64"} {
		if has(h, key) {
			return nil, nil, reject("external_credential_signature_unsupported")
		}
	}
	p, e := decode(parts[1])
	return h, p, e
}
func shape(payload, header Object) (Object, error) {
	direct := header["typ"] == "vc+jwt"
	vc := payload
	format := "vc+jwt-2.0"
	context := "https://www.w3.org/ns/credentials/v2"
	if !direct {
		vc = object(payload["vc"])
		format = "vc-jwt-1.1"
		context = "https://www.w3.org/2018/credentials/v1"
	}
	contexts, ok := vc["@context"].([]any)
	found := false
	for _, v := range contexts {
		if v == context {
			found = true
		}
	}
	if vc == nil || object(vc["credentialSubject"]) == nil || !ok || !found {
		return nil, reject("external_credential_format_unsupported")
	}
	if !direct && has(header, "typ") && header["typ"] != "JWT" && header["typ"] != "jwt" {
		return nil, reject("external_credential_format_unsupported")
	}
	types, ok := vc["type"].([]any)
	found = false
	for _, v := range types {
		if v == "VerifiableCredential" {
			found = true
		}
		if !validText(v, 256) {
			return nil, reject("external_credential_format_invalid")
		}
	}
	if !ok || !found || len(types) > 32 {
		return nil, reject("external_credential_format_invalid")
	}
	issuer := vc["issuer"]
	if id := object(issuer); id != nil {
		issuer = id["id"]
	}
	if _, ok := issuer.(string); !ok {
		issuer = payload["iss"]
	}
	if !validText(issuer, 2048) || has(payload, "iss") && payload["iss"] != issuer {
		return nil, reject("external_credential_issuer_mismatch")
	}
	subject := object(vc["credentialSubject"])["id"]
	if subject == nil {
		subject = payload["sub"]
	}
	if subject != nil && !validText(subject, 2048) || has(payload, "sub") && subject != payload["sub"] {
		return nil, reject("external_credential_subject_invalid")
	}
	issuance, e := dateField(vc, "issuanceDate")
	if e != nil {
		return nil, e
	}
	iat, e := numericField(payload, "iat")
	if e != nil {
		return nil, e
	}
	issued := issuance
	if issued == nil {
		issued = iat
	}
	var start, end *int64
	for _, key := range []string{"validFrom", "issuanceDate"} {
		v, e := dateField(vc, key)
		if e != nil {
			return nil, e
		}
		if v != nil && (start == nil || *v > *start) {
			start = v
		}
	}
	nbf, e := numericField(payload, "nbf")
	if e != nil {
		return nil, e
	}
	if nbf != nil && (start == nil || *nbf > *start) {
		start = nbf
	}
	if start == nil {
		start = issued
	}
	for _, key := range []string{"validUntil", "expirationDate"} {
		v, e := dateField(vc, key)
		if e != nil {
			return nil, e
		}
		if v != nil && (end == nil || *v < *end) {
			end = v
		}
	}
	exp, e := numericField(payload, "exp")
	if e != nil {
		return nil, e
	}
	if exp != nil && (end == nil || *exp < *end) {
		end = exp
	}
	if start != nil && end != nil && *end <= *start {
		return nil, reject("external_credential_validity_invalid")
	}
	id := vc["id"]
	if id == nil {
		id = payload["jti"]
	}
	if id != nil && !validText(id, 2048) {
		return nil, reject("external_credential_format_invalid")
	}
	if has(vc, "id") && has(payload, "jti") && vc["id"] != payload["jti"] {
		return nil, reject("external_credential_id_mismatch")
	}
	scope := object(vc["credentialSubject"])["scope"]
	if scope == nil {
		scope = vc["scope"]
	}
	scopes := []any{}
	if value, ok := scope.(string); ok {
		r := []rune(value)
		if len(r) > 512 {
			value = string(r[:512])
		}
		scopes = append(scopes, value)
	} else if values, ok := scope.([]any); ok {
		for _, v := range values {
			if validText(v, 512) {
				scopes = append(scopes, v)
			}
			if len(scopes) == 32 {
				break
			}
		}
	}
	title := vc["name"]
	if !validText(title, 200) {
		title = "外部签名材料"
		for _, v := range types {
			if v != "VerifiableCredential" {
				title = v
				break
			}
		}
	}
	return Object{"format": format, "issuer": issuer, "subjectId": subject, "credentialId": id, "vc": vc, "types": types, "scope": scopes, "title": title, "issuedAt": isoSeconds(issued), "validFrom": isoSeconds(start), "expiresAt": isoSeconds(end)}, nil
}
func verifySignature(token string, i *Issuer, h Object) error {
	alg, kid := str(h["alg"]), str(h["kid"])
	if !contains(i.Algorithms, alg) {
		return reject("external_credential_signature_invalid")
	}
	for _, raw := range i.Keys {
		if raw["kid"] != kid {
			continue
		}
		if v, ok := raw["alg"]; ok && v != alg {
			continue
		}
		if v, ok := raw["use"]; ok && v != "sig" {
			continue
		}
		if v, ok := raw["key_ops"]; ok {
			verified := false
			for _, op := range v.([]any) {
				if op == "verify" {
					verified = true
				}
			}
			if !verified {
				continue
			}
		}
		b, _ := json.Marshal(raw)
		var key jose.JSONWebKey
		if json.Unmarshal(b, &key) != nil || !key.IsPublic() {
			continue
		}
		if public, ok := key.Key.(*rsa.PublicKey); ok && public.N.BitLen() < 2048 {
			continue
		}
		if public, ok := key.Key.(*ecdsa.PublicKey); ok && (alg == "ES256" && public.Curve.Params().BitSize != 256 || alg == "ES384" && public.Curve.Params().BitSize != 384) {
			continue
		}
		if alg == "Ed25519" {
			public, ok := key.Key.(ed25519.PublicKey)
			parts := strings.Split(token, ".")
			signature, e := base64.RawURLEncoding.DecodeString(parts[2])
			if ok && e == nil && ed25519.Verify(public, []byte(parts[0]+"."+parts[1]), signature) {
				return nil
			}
			continue
		}
		jws, e := jose.ParseSignedCompact(token, []jose.SignatureAlgorithm{jose.SignatureAlgorithm(alg)})
		if e == nil {
			if _, e = jws.Verify(key.Key); e == nil {
				return nil
			}
		}
	}
	return reject("external_credential_signature_invalid")
}
func (s *Service) Verify(token string) (Object, error) {
	h, p, e := tokenParts(token, 131072)
	if e != nil {
		return nil, e
	}
	metadata, e := shape(p, h)
	if e != nil {
		return nil, e
	}
	i := s.issuerURI(str(metadata["issuer"]))
	if i == nil || !contains(i.Formats, str(metadata["format"])) {
		return nil, reject("external_credential_issuer_unconfigured")
	}
	if e = verifySignature(token, i, h); e != nil {
		return nil, e
	}
	if aud, ok := p["aud"]; ok {
		matched := false
		switch a := aud.(type) {
		case string:
			matched = a == s.Endpoint
		case []any:
			all := true
			for _, v := range a {
				if _, ok := v.(string); !ok {
					all = false
				}
				if v == s.Endpoint {
					matched = true
				}
			}
			matched = matched && all
		}
		if !matched {
			return nil, reject("external_credential_audience_mismatch")
		}
	}
	metadata["issuerId"] = i.ID
	metadata["issuerName"] = i.Name
	metadata["algorithm"] = h["alg"]
	metadata["kid"] = h["kid"]
	return metadata, nil
}
