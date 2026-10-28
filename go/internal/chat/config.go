package chat

import (
	"bytes"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

type Configuration struct {
	Version     int    `json:"version"`
	Service     string `json:"service"`
	Domain      string `json:"domain"`
	RoomsDomain string `json:"roomsDomain"`
	SecretFile  string `json:"secretFile"`
}

func boundedFile(path string, limit int64, secret bool) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("absolute chat configuration path required")
	}
	info, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Size() > limit || secret && runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("unsafe chat configuration file")
	}
	return os.ReadFile(path)
}

// LoadTransport validates files without connecting. Start is an explicit
// runtime lifecycle action; no credential value is returned in metadata.
func LoadTransport(path string) (*ComponentTransport, *string, error) {
	if path == "" {
		return nil, nil, nil
	}
	raw, e := boundedFile(path, 8192, false)
	if e != nil {
		return nil, nil, e
	}
	var config Configuration
	if protocol.Decode(raw, &config) != nil || config.Version != 1 || config.Service == "" || config.Domain == "" || config.RoomsDomain == "" || config.SecretFile == "" {
		return nil, nil, fmt.Errorf("invalid chat configuration")
	}
	secret, e := boundedFile(config.SecretFile, 4096, true)
	if e != nil {
		return nil, nil, e
	}
	transport, e := NewComponentTransport(config.Service, config.Domain, config.RoomsDomain, trim(string(secret)), 4*time.Second)
	if e != nil {
		return nil, nil, e
	}
	encoded, _ := protocol.Encode(config)
	// JSON.stringify emits literal U+2028/U+2029. Decode only actual JSON escape
	// sequences, preserving a user path containing the literal backslash text.
	encoded = stringifySeparators(encoded)
	hash := identity.Digest(encoded)
	return transport, &hash, nil
}

func stringifySeparators(raw []byte) []byte {
	out := []byte{}
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+6 <= len(raw) && (bytes.Equal(raw[i:i+6], []byte(`\u2028`)) || bytes.Equal(raw[i:i+6], []byte(`\u2029`))) {
				if raw[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 5
				continue
			}
			out = append(out, raw[i], raw[i+1])
			i++
			continue
		}
		out = append(out, raw[i])
	}
	return out
}
