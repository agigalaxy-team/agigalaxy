package community

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

type GovernanceOptions struct {
	ConfigurationPath, ReviewPath, AuthoritiesPath, Environment, Endpoint string
	Now                                                                   func() time.Time
}
type GovernanceRuntime struct {
	Configuration Object `json:"configuration"`
	Review        Object `json:"review"`
}

func governanceFile(path string, max int64, separate bool) (any, error) {
	if separate && !filepath.IsAbs(path) {
		return nil, fmt.Errorf("absolute governance configuration path required")
	}
	var info os.FileInfo
	var e error
	if separate {
		info, e = os.Lstat(path)
	} else {
		info, e = os.Stat(path)
	}
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || separate && info.Mode()&os.ModeSymlink != 0 || info.Size() > max {
		return nil, fmt.Errorf("invalid governance file")
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	return governanceJSON(raw)
}

// LoadGovernanceForRuntime retains the original pilot/review contract. It reads
// configuration, review, and separate pinned authorities; it never changes them.
func LoadGovernanceForRuntime(options GovernanceOptions) (GovernanceRuntime, error) {
	var raw any = Object{}
	var e error
	if options.ConfigurationPath != "" {
		raw, e = governanceFile(options.ConfigurationPath, 65536, false)
		if e != nil {
			return GovernanceRuntime{}, e
		}
	}
	config, e := parseGovernanceConfiguration(raw)
	if e != nil {
		return GovernanceRuntime{}, e
	}
	result := GovernanceRuntime{Configuration: config, Review: nil}
	if (options.ReviewPath != "") != (options.AuthoritiesPath != "") {
		return GovernanceRuntime{}, fmt.Errorf("both governance review and separate authority pins required")
	}
	if options.ReviewPath == "" {
		if options.Environment == "pilot" {
			for _, v := range config {
				if a, ok := v.([]any); ok && len(a) > 0 {
					return GovernanceRuntime{}, fmt.Errorf("pilot governance configuration requires independent review")
				}
			}
		}
		return result, nil
	}
	if options.ConfigurationPath == "" {
		return GovernanceRuntime{}, fmt.Errorf("reviewed governance configuration file required")
	}
	envelope, e := governanceFile(options.ReviewPath, 32768, true)
	if e != nil {
		return GovernanceRuntime{}, e
	}
	authorities, e := governanceFile(options.AuthoritiesPath, 131072, true)
	if e != nil {
		return GovernanceRuntime{}, e
	}
	now := time.Now().Unix()
	if options.Now != nil {
		now = options.Now().Unix()
	}
	review, e := VerifyGovernanceReview(config, envelope, authorities, options.Endpoint, now)
	if e != nil {
		return GovernanceRuntime{}, e
	}
	result.Review = review
	return result, nil
}
func GovernanceConfigurationHash(config Object) (string, error) {
	raw, e := protocol.Encode(config)
	if e != nil {
		return "", govError()
	}
	value, e := governanceJSON(raw)
	if e != nil {
		return "", e
	}
	parsed, e := parseGovernanceConfiguration(value)
	if e != nil {
		return "", e
	}
	canonical, e := governanceBytes(parsed)
	if e != nil {
		return "", e
	}
	return identity.Digest(canonical), nil
}
func parseGovernanceChange(value any) (Object, error) {
	o, ok := value.(map[string]any)
	if !ok || !strict(o, "version", "changeId", "endpoint", "revision", "previousConfigurationSha256", "configurationSha256", "requesterKid", "reviewerKid", "issuedAt", "expiresAt") || !govInt(o["version"], 1, 1) || !governanceUUID.MatchString(str(o, "changeId")) || !governanceEndpoint(str(o, "endpoint")) || !govInt(o["revision"], 1, safeInteger) || !governanceSHA.MatchString(str(o, "configurationSha256")) || !governanceReference.MatchString(str(o, "requesterKid")) || !governanceReference.MatchString(str(o, "reviewerKid")) || str(o, "requesterKid") == str(o, "reviewerKid") || !govInt(o["issuedAt"], 0, safeInteger) || !govInt(o["expiresAt"], 0, safeInteger) || govNum(o, "expiresAt") <= govNum(o, "issuedAt") || govNum(o, "expiresAt")-govNum(o, "issuedAt") > 30*86400 {
		return nil, fmt.Errorf("invalid governance change")
	}
	previous, present := o["previousConfigurationSha256"]
	if !present || previous != nil && !governanceSHA.MatchString(asString(previous)) {
		return nil, fmt.Errorf("invalid governance change")
	}
	return o, nil
}
func parseGovernanceAuthorities(value any) (Object, error) {
	o, ok := value.(map[string]any)
	if !ok || !strict(o, "version", "endpoint", "requesters", "reviewers") || !govInt(o["version"], 1, 1) || !governanceEndpoint(str(o, "endpoint")) {
		return nil, fmt.Errorf("invalid governance authorities")
	}
	for _, kind := range []string{"requesters", "reviewers"} {
		a, ok := o[kind].([]any)
		if !ok || len(a) < 1 || len(a) > 16 {
			return nil, fmt.Errorf("invalid governance authorities")
		}
		seen := map[string]bool{}
		for _, value := range a {
			p, ok := value.(map[string]any)
			if !ok || !strict(p, "kid", "publicKeyPem", "notBefore", "notAfter", "revoked") || !governanceReference.MatchString(str(p, "kid")) || seen[str(p, "kid")] || govStringLength(p["publicKeyPem"]) < 1 || govStringLength(p["publicKeyPem"]) > 4096 || !govInt(p["notBefore"], 0, safeInteger) || !govInt(p["notAfter"], 0, safeInteger) || !govBool(p, "revoked", nil) {
				return nil, fmt.Errorf("invalid governance authorities")
			}
			seen[str(p, "kid")] = true
		}
	}
	return o, nil
}
func decodeGovernanceBase64(value string) ([]byte, error) {
	if decoded, e := base64.RawURLEncoding.DecodeString(value); e == nil {
		return decoded, nil
	}
	if decoded, e := base64.URLEncoding.DecodeString(value); e == nil {
		return decoded, nil
	}
	if decoded, e := base64.RawStdEncoding.DecodeString(value); e == nil {
		return decoded, nil
	}
	return base64.StdEncoding.DecodeString(value)
}
func governancePublicKey(raw string) (ed25519.PublicKey, []byte, error) {
	block, rest := pem.Decode([]byte(raw))
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) > 0 {
		return nil, nil, fmt.Errorf("governance key type mismatch")
	}
	key, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return nil, nil, e
	}
	public, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, nil, fmt.Errorf("governance key type mismatch")
	}
	der, e := x509.MarshalPKIXPublicKey(public)
	return public, der, e
}
func VerifyGovernanceReview(configuration Object, envelopeInput, authoritiesInput any, endpoint string, now int64) (Object, error) {
	envelope, ok := envelopeInput.(map[string]any)
	if !ok || !strict(envelope, "version", "requestSignature", "reviewSignature") || !govInt(envelope["version"], 1, 1) || len(str(envelope, "requestSignature")) < 1 || len(str(envelope, "requestSignature")) > 16384 || len(str(envelope, "reviewSignature")) < 1 || len(str(envelope, "reviewSignature")) > 16384 {
		return nil, fmt.Errorf("invalid governance review envelope")
	}
	authorities, e := parseGovernanceAuthorities(authoritiesInput)
	if e != nil {
		return nil, e
	}
	if !governanceEndpoint(endpoint) || now < 0 || now > safeInteger {
		return nil, fmt.Errorf("invalid governance review context")
	}
	if str(authorities, "endpoint") != endpoint {
		return nil, fmt.Errorf("governance authority endpoint mismatch")
	}
	type checked struct {
		text        []byte
		change      Object
		fingerprint string
	}
	verified := []checked{}
	for _, pair := range [][3]string{{"requestSignature", "requesters", "requesterKid"}, {"reviewSignature", "reviewers", "reviewerKid"}} {
		signature := str(envelope, pair[0])
		parts := strings.Split(signature, ".")
		if len(parts) != 3 {
			return nil, fmt.Errorf("invalid governance signature")
		}
		headerRaw, e := decodeGovernanceBase64(parts[0])
		if e != nil || !utf8.Valid(headerRaw) {
			return nil, fmt.Errorf("invalid governance signature")
		}
		headerValue, e := governanceJSON(headerRaw)
		if e != nil {
			return nil, e
		}
		header, ok := headerValue.(map[string]any)
		if !ok || !strict(header, "alg", "kid", "typ") || str(header, "alg") != "EdDSA" || str(header, "typ") != "galaxy-governance-change+jws" || len(header) != 3 {
			return nil, fmt.Errorf("governance signature header mismatch")
		}
		var pin Object
		keys := authorities[pair[1]].([]any)
		for _, value := range keys {
			candidate := value.(map[string]any)
			if str(candidate, "kid") == str(header, "kid") {
				pin = candidate
				break
			}
		}
		if pin == nil || truth(pin, "revoked") || now < govNum(pin, "notBefore") || now >= govNum(pin, "notAfter") {
			return nil, fmt.Errorf("governance signing key unavailable")
		}
		public, der, e := governancePublicKey(str(pin, "publicKeyPem"))
		if e != nil {
			return nil, e
		}
		signed, e := decodeGovernanceBase64(parts[2])
		if e != nil || !ed25519.Verify(public, []byte(parts[0]+"."+parts[1]), signed) {
			return nil, fmt.Errorf("invalid governance signature")
		}
		text, e := decodeGovernanceBase64(parts[1])
		if e != nil || !utf8.Valid(text) {
			return nil, fmt.Errorf("invalid governance signature payload")
		}
		value, e := governanceJSON(text)
		if e != nil {
			return nil, e
		}
		change, e := parseGovernanceChange(value)
		if e != nil {
			return nil, e
		}
		if str(change, pair[2]) != str(pin, "kid") || str(change, "endpoint") != endpoint || now < govNum(change, "issuedAt") || now >= govNum(change, "expiresAt") || govNum(change, "issuedAt") < govNum(pin, "notBefore") || govNum(change, "expiresAt") > govNum(pin, "notAfter") {
			return nil, fmt.Errorf("governance change scope or validity mismatch")
		}
		verified = append(verified, checked{text, change, identity.Digest(der)})
	}
	if !bytes.Equal(verified[0].text, verified[1].text) || verified[0].fingerprint == verified[1].fingerprint {
		return nil, fmt.Errorf("independent identical governance review required")
	}
	change := verified[0].change
	hash, e := GovernanceConfigurationHash(configuration)
	if e != nil {
		return nil, e
	}
	if str(change, "configurationSha256") != hash {
		return nil, fmt.Errorf("governance configuration digest mismatch")
	}
	pinsRaw, e := governanceBytes(authorities)
	if e != nil {
		return nil, e
	}
	record := clone(change)
	record["authoritiesSha256"] = identity.Digest(pinsRaw)
	record["requestSignatureSha256"] = identity.Digest([]byte(str(envelope, "requestSignature")))
	record["reviewSignatureSha256"] = identity.Digest([]byte(str(envelope, "reviewSignature")))
	return record, nil
}
