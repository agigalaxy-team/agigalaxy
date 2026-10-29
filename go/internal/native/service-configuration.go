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
	"sort"
	"strings"
	"time"
)

type ServiceConfigurationRequest struct {
	Website        string `json:"website"`
	Endpoint       string `json:"endpoint,omitempty"`
	DataDirectory  string `json:"dataDirectory,omitempty"`
	Output         string `json:"output,omitempty"`
	RootPinsFile   string `json:"rootPinsFile,omitempty"`
	TrustDirectory string `json:"trustDirectory,omitempty"`
	NetworkType    string `json:"networkType,omitempty"`
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

func readSelectedRootPins(path string) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() > 65536 {
		return nil, serviceConfigurationError("root_pins_invalid")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, serviceConfigurationError("root_pins_invalid")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return nil, serviceConfigurationError("root_pins_invalid")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(raw) > 65536 {
		return nil, serviceConfigurationError("root_pins_invalid")
	}
	after, err := file.Stat()
	if err != nil || after.Size() != int64(len(raw)) || !after.ModTime().Equal(opened.ModTime()) {
		return nil, serviceConfigurationError("root_pins_invalid")
	}
	return raw, nil
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
	if (input.RootPinsFile != "") != (input.TrustDirectory != "") || input.RootPinsFile != "" && (!filepath.IsAbs(input.RootPinsFile) || !filepath.IsAbs(input.TrustDirectory)) || input.NetworkType != "" && input.NetworkType != "official" && input.NetworkType != "hub" {
		return nil, serviceConfigurationError("paths_invalid")
	}
	var rootPins map[string]Pin
	if input.RootPinsFile != "" {
		raw, err := readSelectedRootPins(input.RootPinsFile)
		if err != nil {
			return nil, serviceConfigurationError("root_pins_invalid")
		}
		if protocol.Decode(raw, &rootPins) != nil {
			// Accept the existing public root-pins document as well as a keyed
			// host configuration map. It must bind the explicitly chosen origin.
			document, decodeError := connectionObject(raw)
			if decodeError != nil || !connectionExact(document, "version", "endpoint", "sequence", "keys") || !connectionSafeInteger(document["sequence"]) {
				return nil, serviceConfigurationError("root_pins_invalid")
			}
			for _, value := range uploadRows(document["keys"]) {
				row := uploadObject(value)
				if !connectionExact(row, "kid", "publicKeyPem", "notBefore", "notAfter", "revoked") || !connectionSafeInteger(row["notBefore"]) || !connectionSafeInteger(row["notAfter"]) {
					return nil, serviceConfigurationError("root_pins_invalid")
				}
				if _, ok := row["revoked"].(bool); !ok {
					return nil, serviceConfigurationError("root_pins_invalid")
				}
			}
			var source struct {
				Version  int    `json:"version"`
				Endpoint string `json:"endpoint"`
				Sequence int64  `json:"sequence"`
				Keys     []Pin  `json:"keys"`
			}
			if protocol.Decode(raw, &source) != nil || source.Version != 1 || source.Endpoint != input.Endpoint || source.Sequence < 1 || source.Sequence > 9007199254740991 {
				return nil, serviceConfigurationError("root_pins_invalid")
			}
			rootPins = map[string]Pin{}
			for _, pin := range source.Keys {
				if !discoveryKID.MatchString(pin.KID) || !connectionCanonicalPublic(pin.PublicKeyPEM) {
					return nil, serviceConfigurationError("root_pins_invalid")
				}
				if _, exists := rootPins[pin.KID]; exists {
					return nil, serviceConfigurationError("root_pins_invalid")
				}
				rootPins[pin.KID] = pin
			}
		} else {
			value, err := connectionObject(raw)
			if err != nil || !discoveryRootPinsValid(value) {
				return nil, serviceConfigurationError("root_pins_invalid")
			}
		}
		if len(rootPins) == 0 || len(rootPins) > 32 {
			return nil, serviceConfigurationError("root_pins_invalid")
		}
		for id, pin := range rootPins {
			if !discoveryKID.MatchString(id) || pin.NotBefore < 0 || pin.NotAfter <= pin.NotBefore || len(pin.PublicKeyPEM) > 256 {
				return nil, serviceConfigurationError("root_pins_invalid")
			}
			if _, err = connectionPublicPEM(pin.PublicKeyPEM); err != nil {
				return nil, serviceConfigurationError("root_pins_invalid")
			}
		}
	}
	inspected, e := InspectServiceConfiguration(ctx, input, options)
	if e != nil {
		return nil, e
	}
	configuration := Configuration{Version: 2, Endpoint: input.Endpoint, Website: input.Website, DataDirectory: filepath.Clean(input.DataDirectory), TrustedKeys: inspected.TrustedKeys, RootPins: rootPins, TrustDirectory: input.TrustDirectory, NetworkType: input.NetworkType}
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
	trustSource := "explicitly-selected-website-over-HTTPS"
	rootFingerprints := []PublicKeyFingerprint{}
	if len(rootPins) > 0 {
		trustSource = "explicitly-selected-root-pins"
		for id, pin := range rootPins {
			rootFingerprints = append(rootFingerprints, PublicKeyFingerprint{KID: id, SHA256: identity.Digest([]byte(pin.PublicKeyPEM)), NotBefore: pin.NotBefore, NotAfter: pin.NotAfter, Revoked: pin.Revoked})
		}
		sort.Slice(rootFingerprints, func(i, j int) bool { return rootFingerprints[i].KID < rootFingerprints[j].KID })
	}
	result := map[string]any{"configured": true, "output": filepath.Clean(input.Output), "website": input.Website, "endpoint": input.Endpoint, "publicFingerprints": inspected.PublicFingerprints, "publicConfigurationSha256": inspected.PublicConfigurationSHA256, "trustSource": trustSource, "connected": false, "identityCreated": false, "dataDirectoryCreated": false, "automaticKeyRefresh": false}
	if len(rootPins) > 0 {
		result["rootFingerprints"] = rootFingerprints
	}
	return result, nil
}
