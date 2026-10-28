package deviceauth

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

type control struct {
	ChainHead        *string
	PublicKey, KeyID string
	DeviceID         *string
	Epoch            int64
	Scopes           []string
}
type binding struct {
	ID, Subject, Audience string
	DeviceID, KeyID       *string
	Epoch                 *int64
	Scopes, BindingScopes []string
	Expires               time.Time
	Revoked               *time.Time
	ClientID              string
	Control               control
}

func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func lockSubject(ctx context.Context, tx pgx.Tx, id string) (string, error) {
	var key string
	e := tx.QueryRow(ctx, "SELECT public_key FROM public.galaxy_api_lock_subject_control($1,false)", id).Scan(&key)
	if errors.Is(e, pgx.ErrNoRows) {
		return "", denied()
	}
	return key, e
}
func currentControl(ctx context.Context, tx pgx.Tx, b binding) (control, error) {
	public, e := lockSubject(ctx, tx, b.Subject)
	if e != nil {
		return control{}, e
	}
	var epoch int64
	var chainHead string
	e = tx.QueryRow(ctx, "SELECT epoch,event_hash FROM subject_control_heads WHERE subject_id=$1", b.Subject).Scan(&epoch, &chainHead)
	if errors.Is(e, pgx.ErrNoRows) {
		if b.DeviceID != nil || b.Epoch != nil && *b.Epoch != 0 {
			return control{}, fault.New("identity_control_upgrade_required", 409)
		}
		return control{PublicKey: public, KeyID: identity.Digest([]byte(public)), Scopes: []string{"*"}}, nil
	}
	if e != nil {
		return control{}, e
	}
	key := identity.Digest([]byte(public))
	if b.KeyID != nil {
		key = *b.KeyID
	}
	var c control
	e = tx.QueryRow(ctx, `SELECT public_key,key_id,device_id::text,epoch,scopes FROM device_authorizations WHERE subject_id=$1 AND epoch=$2 AND status='active' AND ($3::uuid IS NULL OR device_id=$3) AND key_id=$4`, b.Subject, epoch, b.DeviceID, key).Scan(&c.PublicKey, &c.KeyID, &c.DeviceID, &c.Epoch, &c.Scopes)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && b.Epoch != nil && *b.Epoch != epoch {
		return c, fault.New("identity_control_stale", 401)
	}
	if e == nil {
		c.ChainHead = &chainHead
	}
	return c, e
}
func applyControl(ctx context.Context, tx pgx.Tx, b binding) (binding, error) {
	c, e := currentControl(ctx, tx, b)
	if e != nil {
		if fault.Code(e) != "internal_error" {
			return b, denied()
		}
		return b, e
	}
	b.Control = c
	scopes := []string{}
	for _, s := range b.Scopes {
		if contains(c.Scopes, "*") || contains(c.Scopes, s) {
			scopes = append(scopes, s)
		}
	}
	b.Scopes = scopes
	return b, nil
}
func lockedBinding(ctx context.Context, tx pgx.Tx, id string) (binding, error) {
	var b binding
	var subject string
	e := tx.QueryRow(ctx, "SELECT subject_id FROM bindings WHERE id=$1", id).Scan(&subject)
	if errors.Is(e, pgx.ErrNoRows) {
		return b, denied()
	}
	if e != nil {
		return b, e
	}
	if _, e = lockSubject(ctx, tx, subject); e != nil {
		return b, e
	}
	e = tx.QueryRow(ctx, `SELECT id::text,subject_id,audience,device_id::text,key_id,control_epoch,scopes,expires_at,revoked_at FROM bindings WHERE id=$1 FOR UPDATE`, id).Scan(&b.ID, &b.Subject, &b.Audience, &b.DeviceID, &b.KeyID, &b.Epoch, &b.Scopes, &b.Expires, &b.Revoked)
	if errors.Is(e, pgx.ErrNoRows) {
		return b, denied()
	}
	if e != nil {
		return b, e
	}
	return applyControl(ctx, tx, b)
}
