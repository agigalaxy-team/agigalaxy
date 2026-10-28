package profiles

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func profileFields(o Object, keys ...string) *protocol.OrderedObject {
	v := protocol.NewOrderedObject()
	for _, k := range keys {
		if x, ok := o[k]; ok {
			v.Set(k, x)
		}
	}
	return v
}
func profileArray(v any) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []Object:
		out := []any{}
		for _, v := range a {
			out = append(out, v)
		}
		return out
	}
	return nil
}

// ReadHistoryWireWithin retains the existing ID declaration's schema member
// order for History's JSON.stringify source fingerprint. ReadWithin remains
// the sole source of current identity, latest sharing and content qualification.
func (s *Service) ReadHistoryWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, subject string) (json.RawMessage, error) {
	view, e := s.ReadWithin(ctx, tx, a, subject)
	if e != nil {
		return nil, e
	}
	declared, _ := view["selfDeclared"].(Object)
	self := profileFields(declared, "displayName", "about", "claimedCapabilities")
	if raw, ok := declared["projects"]; ok {
		projects := []any{}
		for _, p := range profileArray(raw) {
			p, _ := p.(Object)
			projects = append(projects, profileFields(p, "id", "kind", "title", "summary", "functions", "technologies", "sourceUrl", "discoverable"))
		}
		self.Set("projects", projects)
	}
	out := protocol.NewOrderedObject()
	out.Set("selfDeclared", self)
	if revision, ok := view["selfDeclaredRevision"]; ok {
		out.Set("selfDeclaredRevision", revision)
		var sharing any
		if v, _ := view["selfDeclaredSharing"].(Object); v != nil {
			sharing = profileFields(v, "visibility", "viewers", "expiresAt", "readExpiresAt", "status", "authorizationExpiresAt", "bindingExpiresAt", "mode")
		}
		out.Set("selfDeclaredSharing", sharing)
		var statement any
		if v, _ := view["selfDeclaredStatement"].(Object); v != nil {
			statement = profileFields(v, "id", "revision", "payloadHash")
		}
		out.Set("selfDeclaredStatement", statement)
	}
	if until, ok := view["selfDeclaredReadExpiresAt"]; ok {
		out.Set("selfDeclaredReadExpiresAt", until)
	}
	if source, _ := view["selfDeclaredSource"].(Object); source != nil {
		out.Set("selfDeclaredSource", profileFields(source, "id", "classification", "capabilityVerified"))
	}
	raw, e := protocol.EncodeJS(out)
	return json.RawMessage(raw), e
}
