package access

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"net/http"
	"path/filepath"
)

// LoadRegisteredDirectory reads the existing independent website-realm
// references. The worker's read-only invocation never opens the writer file.
func LoadRegisteredDirectory(file string, write bool, expectedIssuer string) (*registeredusers.Native, error) {
	return loadRegisteredDirectory(file, write, expectedIssuer, nil)
}
func loadRegisteredDirectory(file string, write bool, expectedIssuer string, transport http.RoundTripper) (*registeredusers.Native, error) {
	if file == "" {
		return nil, nil
	}
	var config map[string]any
	if e := protectedJSON(file, 16384, &config); e != nil {
		return nil, e
	}
	bad := func() (*registeredusers.Native, error) { return nil, fault.New("server_configuration_invalid", 400) }
	version, ok := config["version"].(json.Number)
	number, e := version.Float64()
	if !ok || e != nil || number != 1 {
		return bad()
	}
	raw, ok := config["accountDirectory"].(map[string]any)
	if !ok {
		return bad()
	}
	if _, ok = raw["issuer"]; !ok {
		return bad()
	}
	if _, ok = raw["credentialFile"]; !ok {
		return bad()
	}
	for k := range raw {
		if k != "issuer" && k != "credentialFile" && k != "writerCredentialFile" {
			return bad()
		}
	}
	issuer, ok := raw["issuer"].(string)
	readerFile, rok := raw["credentialFile"].(string)
	if !ok || !rok || issuer == config["issuer"] || expectedIssuer != "" && issuer != expectedIssuer {
		return bad()
	}
	writerFile := ""
	if v, present := raw["writerCredentialFile"]; present {
		var ok bool
		writerFile, ok = v.(string)
		if !ok || !filepath.IsAbs(writerFile) || writerFile == readerFile {
			return bad()
		}
	}
	credential := func(path string) (registeredusers.Credential, error) {
		var v struct {
			Version      int    `json:"version"`
			ClientID     string `json:"clientId"`
			ClientSecret string `json:"clientSecret"`
		}
		if e := protectedJSON(path, 16384, &v); e != nil {
			return registeredusers.Credential{}, e
		}
		if v.Version != 1 || !directoryClientID.MatchString(v.ClientID) || v.ClientSecret == "" || protocol.TextLength(v.ClientSecret) > 4096 {
			return registeredusers.Credential{}, fault.New("server_configuration_invalid", 400)
		}
		return registeredusers.Credential{ClientID: v.ClientID, ClientSecret: v.ClientSecret}, nil
	}
	reader, e := credential(readerFile)
	if e != nil {
		return nil, e
	}
	var writer *registeredusers.Credential
	if write && writerFile != "" {
		v, e := credential(writerFile)
		if e != nil {
			return nil, e
		}
		if v.ClientID == reader.ClientID {
			return bad()
		}
		writer = &v
	}
	origin := ""
	if v, ok := config["directoryOrigin"]; ok {
		origin, ok = v.(string)
		if !ok {
			return bad()
		}
	}
	return registeredusers.NewNative(registeredusers.NativeConfig{Issuer: issuer, AdminOrigin: origin, Reader: reader, Writer: writer, Transport: transport})
}
