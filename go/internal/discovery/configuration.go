package discovery

import (
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type EngineConfiguration struct {
	URL    string `json:"url"`
	APIKey string `json:"apiKey"`
}
type MeiliConfiguration struct {
	URL    string  `json:"url"`
	APIKey string  `json:"apiKey"`
	Index  *string `json:"index,omitempty"`
}
type OpenPanelConfiguration struct {
	URL              string `json:"url"`
	ClientID         string `json:"clientId"`
	ClientSecret     string `json:"clientSecret"`
	ReadClientID     string `json:"readClientId"`
	ReadClientSecret string `json:"readClientSecret"`
	ProjectID        string `json:"projectId"`
}
type IdentityProvider struct {
	Issuer   string `json:"issuer"`
	ClientID string `json:"clientId"`
}
type SourceMetadata struct {
	ModeratorIDs      []string           `json:"moderatorIds"`
	IdentityProviders []IdentityProvider `json:"identityProviders"`
}
type Configuration struct {
	Version        int                     `json:"version"`
	Endpoint       string                  `json:"endpoint"`
	WebsiteOrigin  string                  `json:"websiteOrigin"`
	VisitorSecret  string                  `json:"visitorSecret"`
	Meilisearch    *MeiliConfiguration     `json:"meilisearch"`
	Gorse          *EngineConfiguration    `json:"gorse"`
	OpenPanel      *OpenPanelConfiguration `json:"openpanel"`
	SourceMetadata *SourceMetadata         `json:"sourceMetadata,omitempty"`
}

func configSecret(v string) bool {
	return codePointLength(v) >= 32 && codePointLength(v) <= 4096
}
func configURL(v string) bool { u, e := url.Parse(v); return e == nil && u.IsAbs() && u.Scheme != "" }
func nativeOrigin(value string) (string, error) {
	u, e := url.Parse(value)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fail("discovery_configuration_invalid")
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme == "http" && host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return "", fail("discovery_configuration_invalid")
	}
	return normalizedOrigin(u), nil
}
func normalizedOrigin(u *url.URL) string {
	host := strings.ToLower(u.Host)
	if u.Scheme == "http" && u.Port() == "80" || u.Scheme == "https" && u.Port() == "443" {
		host = strings.TrimSuffix(host, ":"+u.Port())
	}
	return u.Scheme + "://" + host
}

var moderatorID = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)

// LoadConfiguration reads only an explicit protected reference. It never logs
// the configuration or resolves credentials from environment fallbacks.
func LoadConfiguration(path, endpoint string) (*Configuration, error) {
	if path == "" {
		return nil, nil
	}
	if !filepath.IsAbs(path) {
		return nil, fail("discovery_configuration_invalid")
	}
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 32768 || runtime.GOOS != "windows" && info.Mode().Perm()&7 != 0 {
		return nil, fail("discovery_configuration_invalid")
	}
	file, e := os.Open(path)
	if e != nil {
		return nil, fail("discovery_configuration_invalid")
	}
	defer file.Close()
	raw, e := io.ReadAll(io.LimitReader(file, 32769))
	if e != nil || len(raw) > 32768 {
		return nil, fail("discovery_configuration_invalid")
	}
	var config Configuration
	if e = protocol.Decode(raw, &config); e != nil {
		return nil, fail("discovery_configuration_invalid")
	}
	var fields Object
	if decode(raw, &fields) != nil || fields == nil {
		return nil, fail("discovery_configuration_invalid")
	}
	if value, present := fields["sourceMetadata"]; present && value == nil {
		return nil, fail("discovery_configuration_invalid")
	}
	if value, present := object(fields["meilisearch"])["index"]; present && value == nil {
		return nil, fail("discovery_configuration_invalid")
	}
	if config.Version != 1 || !configURL(config.Endpoint) || config.Endpoint != endpoint || !configSecret(config.VisitorSecret) || config.Meilisearch == nil || config.Gorse == nil || config.OpenPanel == nil {
		return nil, fail("discovery_configuration_invalid")
	}
	website, e := url.Parse(config.WebsiteOrigin)
	if e != nil || website.Scheme != "https" || website.User != nil || website.Host == "" || website.Path != "" || website.RawQuery != "" || website.Fragment != "" || website.ForceQuery || normalizedOrigin(website) != config.WebsiteOrigin {
		return nil, fail("discovery_configuration_invalid")
	}
	m, g, o := config.Meilisearch, config.Gorse, config.OpenPanel
	if !configSecret(m.APIKey) || !configSecret(g.APIKey) || !configSecret(o.ClientSecret) || !configSecret(o.ReadClientSecret) || !validID(o.ClientID) || !validID(o.ReadClientID) || !validID(o.ProjectID) || m.Index != nil && !indexName.MatchString(*m.Index) {
		return nil, fail("discovery_configuration_invalid")
	}
	for _, address := range []*string{&m.URL, &g.URL, &o.URL} {
		normalized, e := nativeOrigin(*address)
		if e != nil {
			return nil, e
		}
		*address = normalized
	}
	if source := config.SourceMetadata; source != nil {
		if source.ModeratorIDs == nil || source.IdentityProviders == nil || len(source.ModeratorIDs) > 8 || len(source.IdentityProviders) > 8 {
			return nil, fail("discovery_configuration_invalid")
		}
		seen := map[string]bool{}
		for _, id := range source.ModeratorIDs {
			if !moderatorID.MatchString(id) || seen[id] {
				return nil, fail("discovery_configuration_invalid")
			}
			seen[id] = true
		}
		for _, provider := range source.IdentityProviders {
			if !configURL(provider.Issuer) || codePointLength(provider.ClientID) < 1 || codePointLength(provider.ClientID) > 200 {
				return nil, fail("discovery_configuration_invalid")
			}
		}
	}
	return &config, nil
}
