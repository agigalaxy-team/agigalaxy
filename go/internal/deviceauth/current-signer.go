package deviceauth

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// CurrentSignerWithin resolves retained signed evidence against the current
// control key in the caller's transaction. It does not authenticate a request or
// establish binding/consent authority. The evidence reader must still lock and
// check its own binding, explicit revocations and exact signed payload.
func (s *Service) CurrentSignerWithin(ctx context.Context, tx pgx.Tx, subject string, deviceID, keyID *string, epoch int64, scope string) (ControlAuthorization, error) {
	c, e := currentControl(ctx, tx, binding{Subject: subject, DeviceID: deviceID, KeyID: keyID, Epoch: &epoch})
	if e != nil {
		return ControlAuthorization{}, e
	}
	if scope != "" && !contains(c.Scopes, "*") && !contains(c.Scopes, scope) {
		return ControlAuthorization{}, fault.New("identity_control_stale", 401)
	}
	return ControlAuthorization{PublicKey: c.PublicKey, KeyID: c.KeyID, Epoch: c.Epoch, ChainHead: c.ChainHead, DeviceID: c.DeviceID}, nil
}
