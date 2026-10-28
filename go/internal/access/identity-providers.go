package access

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"regexp"
	"unicode"
	"unicode/utf8"
)

// LoadIdentityProviders exposes the public issuer/client
// configuration for independent read workers. Secret references are validated
// as names only; this function never resolves them or creates a login service.
func LoadIdentityProviders(path string) ([]accounts.Provider, error) {
	out := []accounts.Provider{}
	if path == "" {
		return out, nil
	}
	var config identityConfiguration
	if e := publicJSON(path, 32768, &config); e != nil {
		return nil, e
	}
	bad := func() ([]accounts.Provider, error) { return nil, fault.New("server_configuration_invalid", 400) }
	if config.Version != 1 || len(config.Providers) > 8 {
		return bad()
	}
	seen := map[string]bool{}
	id := regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	env := regexp.MustCompile(`^GALAXY_OIDC_[A-Z0-9_]{1,80}$`)
	valid := func(s string, max int) bool {
		if utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > max {
			return false
		}
		for _, r := range s {
			if unicode.IsControl(r) {
				return false
			}
		}
		return true
	}
	for _, p := range config.Providers {
		if !id.MatchString(p.ID) || seen[p.ID] || !valid(p.Name, 100) || !valid(p.ClientID, 200) || p.SecretEnvironment != "" && !env.MatchString(p.SecretEnvironment) {
			return bad()
		}
		seen[p.ID] = true
		if _, e := portal.NewOIDCLoader(portal.OIDCConfig{Issuer: p.Issuer, ClientID: p.ClientID, AllowedOrigins: p.Origins}); e != nil {
			return bad()
		}
		out = append(out, accounts.Provider{Issuer: p.Issuer, ClientID: p.ClientID})
	}
	return out, nil
}
