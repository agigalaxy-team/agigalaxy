package deviceauth

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// ControlAuthorization contains only the current device's public verification
// material. The caller holds the original binding/credential/control locks in
// its real business transaction; PublicState alone cannot grant this authority.
type ControlAuthorization struct {
	CredentialScopes, BindingScopes []string
	PublicKey, KeyID                string
	Epoch                           int64
	ChainHead, DeviceID             *string
}

func (s *Service) CurrentControlWithin(ctx context.Context, tx pgx.Tx, actor Actor, scope string) (ControlAuthorization, error) {
	row, e := s.authorizationWithin(ctx, tx, actor)
	if e != nil {
		return ControlAuthorization{}, e
	}
	if !contains(row.Scopes, scope) {
		return ControlAuthorization{}, denied()
	}
	c := row.Control
	return ControlAuthorization{CredentialScopes: append([]string(nil), row.Scopes...), BindingScopes: append([]string(nil), row.BindingScopes...), PublicKey: c.PublicKey, KeyID: c.KeyID, Epoch: c.Epoch, ChainHead: c.ChainHead, DeviceID: c.DeviceID}, nil
}
