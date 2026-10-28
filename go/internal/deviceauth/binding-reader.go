package deviceauth

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"time"
)

// BindingControlWithin is the original bindingControl reader for a target
// binding, not caller authentication. The caller first establishes its own
// business authority. Current subject control is shared-locked by applyControl;
// reads do not upgrade the caller's credential binding SHARE lock to UPDATE.
func (s *Service) BindingControlWithin(ctx context.Context, tx pgx.Tx, id, subject, scope string) (map[string]any, error) {
	var raw []byte
	e := tx.QueryRow(ctx, "SELECT to_jsonb(b) FROM bindings b WHERE id=$1 AND subject_id=$2", id, subject).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var fields struct {
		ID       string     `json:"id"`
		Subject  string     `json:"subject_id"`
		Audience string     `json:"audience"`
		DeviceID *string    `json:"device_id"`
		KeyID    *string    `json:"key_id"`
		Epoch    *int64     `json:"control_epoch"`
		Scopes   []string   `json:"scopes"`
		Expires  time.Time  `json:"expires_at"`
		Revoked  *time.Time `json:"revoked_at"`
	}
	if e = json.Unmarshal(raw, &fields); e != nil {
		return nil, e
	}
	b, e := applyControl(ctx, tx, binding{ID: fields.ID, Subject: fields.Subject, Audience: fields.Audience, DeviceID: fields.DeviceID, KeyID: fields.KeyID, Epoch: fields.Epoch, Scopes: fields.Scopes, Expires: fields.Expires, Revoked: fields.Revoked})
	if e != nil {
		if fault.Code(e) != "internal_error" {
			return nil, nil
		}
		return nil, e
	}
	if scope != "" && !contains(b.Control.Scopes, "*") && !contains(b.Control.Scopes, scope) {
		return nil, nil
	}
	var out map[string]any
	if e = json.Unmarshal(raw, &out); e != nil {
		return nil, e
	}
	out["public_key"] = b.Control.PublicKey
	out["scopes"] = append([]string{}, b.Scopes...)
	out["control"] = map[string]any{"publicKey": b.Control.PublicKey, "keyId": b.Control.KeyID, "deviceId": b.Control.DeviceID, "epoch": b.Control.Epoch, "chainHead": b.Control.ChainHead, "scopes": append([]string{}, b.Control.Scopes...)}
	return out, nil
}
