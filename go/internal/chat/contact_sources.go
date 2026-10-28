package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// ReadContactWithin is the original contact current view, for an export/other
// trusted consumer's existing transaction; it does not open a nested tx or
// infer private access from an Account shared by another GUID.
func (f *ContactService) ReadContactWithin(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, id string) (Object, error) {
	if f == nil || f.Chat == nil || f.Chat.Devices == nil {
		return nil, fail("contact_service_unavailable", 503)
	}
	if _, e := f.Chat.Devices.CurrentControlWithin(ctx, tx, actor, "history"); e != nil {
		return nil, e
	}
	return f.read(ctx, tx, Actor{Device: &actor}, id)
}
