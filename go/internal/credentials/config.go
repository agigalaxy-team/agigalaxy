package credentials

import (
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
	"math"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Object = map[string]any
type Configuration struct {
	Version int      `json:"version"`
	Issuers []Issuer `json:"issuers"`
}
type Issuer struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Issuer         string          `json:"issuer"`
	Algorithms     []string        `json:"algorithms,omitempty"`
	Keys           []Object        `json:"keys"`
	Formats        []string        `json:"formats,omitempty"`
	SubjectBinding *SubjectBinding `json:"subjectBinding,omitempty"`
	Revocation     *Revocation     `json:"revocation,omitempty"`
	Conditions     []Condition     `json:"conditions,omitempty"`
}
type SubjectBinding struct {
	Kind          string `json:"kind"`
	AccountIssuer string `json:"accountIssuer"`
}
type Revocation struct {
	Kind          string `json:"kind"`
	URL           string `json:"url"`
	MaxAgeSeconds int    `json:"maxAgeSeconds,omitempty"`
}
type Condition struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Type  string `json:"type"`
	Claim *Claim `json:"claim,omitempty"`
}
type Claim struct {
	Path   string `json:"path"`
	Equals any    `json:"equals"`
}

var identifier = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

func configError() error { return errors.New("invalid external credential configuration") }

// LoadConfiguration has no environment/home discovery. Fixed public keys and
// status sources come only from this explicitly supplied regular absolute file.
func LoadConfiguration(path string) (Configuration, error) {
	if path == "" {
		return Configuration{Version: 1, Issuers: []Issuer{}}, nil
	}
	if !filepath.IsAbs(path) {
		return Configuration{}, configError()
	}
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 262144 {
		return Configuration{}, configError()
	}
	raw, e := os.ReadFile(path)
	if e != nil || len(raw) > 262144 {
		return Configuration{}, configError()
	}
	return ParseConfiguration(raw)
}
func trimConfig(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r >= 0x2000 && r <= 0x200a || strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff", r)
	})
}
func plain(s string, max int) bool {
	if s == "" || protocol.TextLength(s) > max {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func uri(s string) bool {
	u, e := url.Parse(s)
	if !plain(s, 2048) || e != nil || !u.IsAbs() || u.User != nil {
		return false
	}
	if contains([]string{"http", "https", "ftp", "ws", "wss"}, u.Scheme) && u.Host == "" {
		return false
	}
	return true
}
func publicAddress(a netip.Addr) bool { return publicfetch.IsPublicAddress(a) }
func publicURL(s string) bool         { return publicfetch.ValidURL(s) }
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func ParseConfiguration(raw []byte) (Configuration, error) {
	var c Configuration
	if protocol.Decode(raw, &c) != nil {
		return c, configError()
	}
	var fields struct {
		Issuers []map[string]json.RawMessage `json:"issuers"`
	}
	if json.Unmarshal(raw, &fields) != nil {
		return c, configError()
	}
	for _, issuer := range fields.Issuers {
		for _, key := range []string{"algorithms", "formats", "subjectBinding", "revocation", "conditions"} {
			if value, ok := issuer[key]; ok && string(value) == "null" {
				return c, configError()
			}
		}
		if value, ok := issuer["revocation"]; ok {
			var r map[string]json.RawMessage
			if json.Unmarshal(value, &r) != nil {
				return c, configError()
			}
			if age, ok := r["maxAgeSeconds"]; ok {
				var n float64
				if json.Unmarshal(age, &n) != nil || string(age) == "null" || n < 10 || n > 3600 || n != float64(int(n)) {
					return c, configError()
				}
			}
		}
		if value, ok := issuer["conditions"]; ok {
			var conditions []map[string]json.RawMessage
			if json.Unmarshal(value, &conditions) != nil {
				return c, configError()
			}
			for _, condition := range conditions {
				if claim, ok := condition["claim"]; ok && string(claim) == "null" {
					return c, configError()
				}
			}
		}
	}
	return normalize(c)
}
func normalize(c Configuration) (Configuration, error) {
	if c.Version != 1 || c.Issuers == nil || len(c.Issuers) > 32 {
		return c, configError()
	}
	ids, uris := map[string]bool{}, map[string]bool{}
	for n := range c.Issuers {
		i := &c.Issuers[n]
		i.Name = trimConfig(i.Name)
		i.Issuer = trimConfig(i.Issuer)
		if !identifier.MatchString(i.ID) || !plain(i.Name, 160) || !uri(i.Issuer) || ids[i.ID] || uris[i.Issuer] || len(i.Keys) < 1 || len(i.Keys) > 16 {
			return c, configError()
		}
		ids[i.ID] = true
		uris[i.Issuer] = true
		if i.Algorithms == nil {
			i.Algorithms = []string{"EdDSA", "RS256", "ES256"}
		}
		if len(i.Algorithms) < 1 || len(i.Algorithms) > 6 {
			return c, configError()
		}
		for _, a := range i.Algorithms {
			if !contains([]string{"EdDSA", "Ed25519", "RS256", "PS256", "ES256", "ES384"}, a) {
				return c, configError()
			}
		}
		if i.Formats == nil {
			i.Formats = []string{"vc-jwt-1.1", "vc+jwt-2.0"}
		}
		if len(i.Formats) < 1 || len(i.Formats) > 2 {
			return c, configError()
		}
		for _, f := range i.Formats {
			if !contains([]string{"vc-jwt-1.1", "vc+jwt-2.0"}, f) {
				return c, configError()
			}
		}
		keyIDs := map[string]bool{}
		for _, k := range i.Keys {
			kid, _ := k["kid"].(string)
			kty, _ := k["kty"].(string)
			if !contains([]string{"OKP", "RSA", "EC"}, kty) || kid == "" || protocol.TextLength(kid) > 200 || keyIDs[kid] {
				return c, configError()
			}
			keyIDs[kid] = true
			for field := range k {
				if !contains([]string{"kty", "crv", "x", "y", "n", "e", "kid", "alg", "use", "key_ops"}, field) {
					return c, configError()
				}
			}
			if use, ok := k["use"]; ok && use != "sig" {
				return c, configError()
			}
			if operations, ok := k["key_ops"]; ok {
				values, ok := operations.([]any)
				if !ok {
					return c, configError()
				}
				for _, v := range values {
					if v != "verify" {
						return c, configError()
					}
				}
			}
		}
		if i.SubjectBinding != nil {
			i.SubjectBinding.AccountIssuer = trimConfig(i.SubjectBinding.AccountIssuer)
			if i.SubjectBinding.Kind != "verified-external-account" || !uri(i.SubjectBinding.AccountIssuer) {
				return c, configError()
			}
		}
		if i.Revocation != nil {
			r := i.Revocation
			r.URL = trimConfig(r.URL)
			if r.MaxAgeSeconds == 0 {
				r.MaxAgeSeconds = 300
			}
			if r.Kind != "signed-list" || !publicURL(r.URL) || r.MaxAgeSeconds < 10 || r.MaxAgeSeconds > 3600 {
				return c, configError()
			}
		}
		if len(i.Conditions) > 32 {
			return c, configError()
		}
		conditionIDs := map[string]bool{}
		for index := range i.Conditions {
			condition := &i.Conditions[index]
			condition.Label = trimConfig(condition.Label)
			condition.Type = trimConfig(condition.Type)
			if !identifier.MatchString(condition.ID) || conditionIDs[condition.ID] || !plain(condition.Label, 160) || !plain(condition.Type, 256) {
				return c, configError()
			}
			conditionIDs[condition.ID] = true
			if condition.Claim != nil {
				claim := condition.Claim
				if len(claim.Path) > 512 || !strings.HasPrefix(claim.Path, "/credentialSubject/") {
					return c, configError()
				}
				for _, p := range strings.Split(claim.Path, "/") {
					if p == "__proto__" || p == "prototype" || p == "constructor" {
						return c, configError()
					}
				}
				switch v := claim.Equals.(type) {
				case string:
					claim.Equals = trimConfig(v)
					if !plain(claim.Equals.(string), 2048) {
						return c, configError()
					}
				case bool:
				case float64:
					if math.IsNaN(v) || math.IsInf(v, 0) {
						return c, configError()
					}
				case json.Number:
					n, e := v.Float64()
					if e != nil || math.IsNaN(n) || math.IsInf(n, 0) {
						return c, configError()
					}
				default:
					return c, configError()
				}
			}
		}
	}
	return c, nil
}
