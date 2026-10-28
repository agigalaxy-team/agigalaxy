package native

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"net/url"
	"os"
	"path/filepath"
)

type Pin struct {
	PublicKeyPEM string `json:"publicKeyPem"`
	NotBefore    int64  `json:"notBefore"`
	NotAfter     int64  `json:"notAfter"`
	TrustedUntil *int64 `json:"trustedUntil,omitempty"`
	Revoked      bool   `json:"revoked"`
}
type Configuration struct {
	Version           int             `json:"version"`
	Endpoint          string          `json:"endpoint"`
	Website           string          `json:"website"`
	DataDirectory     string          `json:"dataDirectory"`
	TrustedKeys       map[string]Pin  `json:"trustedKeys"`
	A2A               json.RawMessage `json:"a2a,omitempty"`
	WatchHost         json.RawMessage `json:"watchHost,omitempty"`
	WorkerPacks       json.RawMessage `json:"workerPacks,omitempty"`
	HostNotifications json.RawMessage `json:"hostNotifications,omitempty"`
}

func ReadConfiguration(path string) (Configuration, error) {
	var c Configuration
	if !filepath.IsAbs(path) {
		return c, fault.New("native_configuration_path_required", 400)
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return c, fault.New("native_configuration_unreadable", 400)
	}
	if len(b) > 65536 {
		return c, fault.New("native_configuration_too_large", 400)
	}
	if e = protocol.Decode(b, &c); e != nil {
		return c, fault.New("native_configuration_invalid", 400)
	}
	if c.Version != 2 || !filepath.IsAbs(c.DataDirectory) || c.TrustedKeys == nil {
		return c, fault.New("native_configuration_invalid", 400)
	}
	for _, s := range []string{c.Endpoint, c.Website} {
		u, e := url.Parse(s)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
			return c, fault.New("native_configuration_invalid", 400)
		}
	}
	return c, nil
}
