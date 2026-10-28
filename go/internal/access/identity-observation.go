package access

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func identityConfigurationHash(c identityConfiguration) (string, error) {
	type provider struct {
		ID                string   `json:"id"`
		Name              string   `json:"name"`
		Issuer            string   `json:"issuer"`
		ClientID          string   `json:"clientId"`
		SecretEnvironment string   `json:"clientSecretEnv,omitempty"`
		Origins           []string `json:"allowedOrigins"`
	}
	out := struct {
		Version   int        `json:"version"`
		Providers []provider `json:"providers"`
	}{Version: c.Version, Providers: []provider{}}
	for _, p := range c.Providers {
		out.Providers = append(out.Providers, provider{p.ID, p.Name, p.Issuer, p.ClientID, p.SecretEnvironment, append([]string{}, p.Origins...)})
	}
	raw, e := protocol.EncodeJS(out)
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
