package servicemetadata

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

// ManifestObservation projects the exact manifest data already constructed by
// this service. It neither signs a fresh document nor reopens a profile file.
func (s *Service) ManifestObservation() (map[string]any, error) {
	if s == nil {
		return nil, nil
	}
	raw, e := identity.Canonical([]any{s.data})
	if e != nil {
		return nil, e
	}
	return map[string]any{"type": s.data["networkType"], "manifestSha256": identity.Digest(raw[1 : len(raw)-1])}, nil
}
