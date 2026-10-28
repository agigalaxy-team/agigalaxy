package native

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type ServiceConfigurationRequest struct {
	Website       string `json:"website"`
	Endpoint      string `json:"endpoint,omitempty"`
	DataDirectory string `json:"dataDirectory,omitempty"`
	Output        string `json:"output,omitempty"`
}
type ServiceConfigurationOptions struct {
	HTTPClient *http.Client
	Now        func() time.Time
}
type PublicKeyFingerprint struct {
	KID       string `json:"kid"`
	SHA256    string `json:"sha256"`
	NotBefore int64  `json:"notBefore"`
	NotAfter  int64  `json:"notAfter"`
	Revoked   bool   `json:"revoked"`
}
type ServiceConfigurationInspection struct {
	Version                   int                    `json:"version"`
	Endpoint                  string                 `json:"endpoint"`
	Website                   string                 `json:"website"`
	TrustedKeys               map[string]Pin         `json:"trustedKeys"`
	PublicFingerprints        []PublicKeyFingerprint `json:"publicFingerprints"`
	PublicConfigurationSHA256 string                 `json:"publicConfigurationSha256"`
	Operator                  *string                `json:"operator"`
}

func serviceConfigurationError(code string) error {
	return fault.New("native_service_configuration_"+code, 400)
}
func serviceConfigurationOrigin(value string) bool {
	u, e := url.Parse(value)
	return e == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && u.Port() != "443" && u.Host == strings.ToLower(u.Host) && u.String() == value
}
func serviceConfigurationKeys(value map[string]any, keys ...string) bool {
	if value == nil {
		return false
	}
	for key := range value {
		found := false
		for _, allowed := range keys {
			if key == allowed {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func serviceConfigurationInteger(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	f, e := number.Float64()
	if e != nil || math.IsInf(f, 0) || math.IsNaN(f) || math.Trunc(f) != f || math.Abs(f) > 9007199254740991 {
		return 0, false
	}
	return int64(f), true
}
func InspectServiceConfiguration(ctx context.Context, input ServiceConfigurationRequest, options ServiceConfigurationOptions) (*ServiceConfigurationInspection, error) {
	if !serviceConfigurationOrigin(input.Website) || input.Endpoint != "" && !serviceConfigurationOrigin(input.Endpoint) {
		return nil, serviceConfigurationError("origin_invalid")
	}
	client := http.Client{Timeout: 10 * time.Second}
	if options.HTTPClient != nil {
		client = *options.HTTPClient
	}
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if client.Timeout <= 0 || client.Timeout > 10*time.Second {
		client.Timeout = 10 * time.Second
	}
	request, e := http.NewRequestWithContext(ctx, http.MethodGet, input.Website+"/galaxy-web-config.json", nil)
	if e != nil {
		return nil, serviceConfigurationError("origin_invalid")
	}
	request.Header.Set("Cache-Control", "no-store")
	request.Header.Set("Accept", "application/json")
	response, e := client.Do(request)
	if e != nil {
		return nil, serviceConfigurationError("unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Body == nil || response.ContentLength > 16384 {
		return nil, serviceConfigurationError("unavailable")
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 16385))
	if e != nil || len(raw) > 16384 {
		return nil, serviceConfigurationError("bounded_read_failed")
	}
	source, e := connectionObject(raw)
	if e != nil {
		return nil, serviceConfigurationError("json_invalid")
	}
	version, versionOK := serviceConfigurationInteger(source["version"])
	keys, keysOK := source["signingKeys"].([]any)
	if !serviceConfigurationKeys(source, "version", "endpoint", "operator", "signingKeys") || !versionOK || version != 1 || !keysOK || len(keys) < 1 || len(keys) > 32 || !serviceConfigurationOrigin(text(source["endpoint"])) || input.Endpoint != "" && source["endpoint"] != input.Endpoint {
		return nil, serviceConfigurationError("selection_mismatch")
	}
	inspection := &ServiceConfigurationInspection{Version: 2, Endpoint: text(source["endpoint"]), Website: input.Website, TrustedKeys: map[string]Pin{}, PublicFingerprints: []PublicKeyFingerprint{}, PublicConfigurationSHA256: identity.Digest(raw)}
	if operator, ok := source["operator"].(string); ok {
		inspection.Operator = &operator
	}
	now := time.Now()
	if options.Now != nil {
		now = options.Now()
	}
	valid := false
	for _, value := range keys {
		pin := uploadObject(value)
		kid, kidOK := pin["kid"].(string)
		public, publicOK := pin["publicKeyPem"].(string)
		before, beforeOK := serviceConfigurationInteger(pin["notBefore"])
		after, afterOK := serviceConfigurationInteger(pin["notAfter"])
		revoked, revokedOK := pin["revoked"].(bool)
		if !serviceConfigurationKeys(pin, "kid", "publicKeyPem", "notBefore", "notAfter", "revoked") || !kidOK || protocol.TextLength(kid) < 1 || protocol.TextLength(kid) > 160 || !publicOK || protocol.TextLength(public) > 4096 || !beforeOK || !afterOK || after <= before || !revokedOK {
			return nil, serviceConfigurationError("signing_key_invalid")
		}
		for _, character := range kid {
			if character < 32 {
				return nil, serviceConfigurationError("signing_key_invalid")
			}
		}
		if _, exists := inspection.TrustedKeys[kid]; exists {
			return nil, serviceConfigurationError("signing_key_invalid")
		}
		if !strings.HasPrefix(public, "-----BEGIN PUBLIC KEY-----") {
			return nil, serviceConfigurationError("signing_key_invalid")
		}
		block, rest := pem.Decode([]byte(public))
		if block == nil || block.Type != "PUBLIC KEY" || uploadTrim(string(rest)) != "" {
			return nil, serviceConfigurationError("signing_key_invalid")
		}
		parsed, e := x509.ParsePKIXPublicKey(block.Bytes)
		key, ed25519OK := parsed.(ed25519.PublicKey)
		if e != nil || !ed25519OK {
			return nil, serviceConfigurationError("signing_key_invalid")
		}
		canonical, e := identity.PublicPEM(key)
		if e != nil || uploadTrim(canonical) != uploadTrim(public) {
			return nil, serviceConfigurationError("signing_key_invalid")
		}
		der, e := x509.MarshalPKIXPublicKey(key)
		if e != nil {
			return nil, e
		}
		inspection.TrustedKeys[kid] = Pin{PublicKeyPEM: public, NotBefore: before, NotAfter: after, Revoked: revoked}
		inspection.PublicFingerprints = append(inspection.PublicFingerprints, PublicKeyFingerprint{kid, identity.Digest(der), before, after, revoked})
		if !revoked && before <= now.Unix() && after > now.Unix() {
			valid = true
		}
	}
	if !valid {
		return nil, serviceConfigurationError("no_current_key")
	}
	return inspection, nil
}
func PrepareServiceConfiguration(ctx context.Context, input ServiceConfigurationRequest, options ServiceConfigurationOptions) (any, error) {
	if !serviceConfigurationOrigin(input.Website) || !serviceConfigurationOrigin(input.Endpoint) || !filepath.IsAbs(input.DataDirectory) || !filepath.IsAbs(input.Output) || filepath.Clean(input.DataDirectory) == filepath.Clean(input.Output) {
		return nil, serviceConfigurationError("paths_invalid")
	}
	inspected, e := InspectServiceConfiguration(ctx, input, options)
	if e != nil {
		return nil, e
	}
	configuration := Configuration{Version: 2, Endpoint: input.Endpoint, Website: input.Website, DataDirectory: filepath.Clean(input.DataDirectory), TrustedKeys: inspected.TrustedKeys}
	raw, e := protocol.Encode(configuration)
	if e != nil {
		return nil, e
	}
	var pretty any
	if e = json.Unmarshal(raw, &pretty); e != nil {
		return nil, e
	}
	raw, e = json.MarshalIndent(pretty, "", "  ")
	if e != nil {
		return nil, e
	}
	raw = append(raw, '\n')
	file, e := os.OpenFile(input.Output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return nil, e
	}
	_, writeError := file.Write(raw)
	closeError := file.Close()
	if writeError != nil {
		return nil, writeError
	}
	if closeError != nil {
		return nil, closeError
	}
	return map[string]any{"configured": true, "output": filepath.Clean(input.Output), "website": input.Website, "endpoint": input.Endpoint, "publicFingerprints": inspected.PublicFingerprints, "publicConfigurationSha256": inspected.PublicConfigurationSHA256, "trustSource": "explicitly-selected-website-over-HTTPS", "connected": false, "identityCreated": false, "dataDirectoryCreated": false, "automaticKeyRefresh": false}, nil
}
