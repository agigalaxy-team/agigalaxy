package deviceauth

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ConsentReceipt(ctx context.Context, a Actor, id string) (map[string]any, error) {
	if !consentUUID.MatchString(id) {
		return nil, fault.New("invalid_consent_id", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		if e := s.AuthorizeWithin(ctx, tx, a, "consent"); e != nil {
			return nil, e
		}
		var intent []byte
		var hash string
		var revoked, bindingRevoked *time.Time
		var expiry, bindingExpiry time.Time
		e := tx.QueryRow(ctx, `SELECT c.intent,c.signature_hash,c.revoked_at,c.expires_at,b.revoked_at,b.expires_at FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.id=$1 AND c.subject_id=$2 FOR SHARE OF c,b`, id, a.SubjectID).Scan(&intent, &hash, &revoked, &expiry, &bindingRevoked, &bindingExpiry)
		if errors.Is(e, pgx.ErrNoRows) {
			return map[string]any{"consentId": id, "state": "absent"}, nil
		}
		if e != nil {
			return nil, e
		}
		status := "active"
		if revoked != nil || bindingRevoked != nil {
			status = "revoked"
		} else if min(expiry.Unix(), bindingExpiry.Unix()) <= s.now() {
			status = "expired"
		}
		return map[string]any{"consentId": id, "state": "recorded", "intent": json.RawMessage(intent), "signatureHash": hash, "status": status}, nil
	})
}
func (s *Service) ListConsents(ctx context.Context, a Actor, after *string) (map[string]any, error) {
	if after != nil && !consentUUID.MatchString(*after) {
		return nil, fault.New("invalid_cursor", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		if e := s.AuthorizeWithin(ctx, tx, a, "consent"); e != nil {
			return nil, e
		}
		rows, e := tx.Query(ctx, `SELECT c.id::text,c.intent,c.signature_envelope,c.revoked_at,c.expires_at,b.revoked_at,b.expires_at FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.subject_id=$1 AND ($2::uuid IS NULL OR c.id>$2::uuid) ORDER BY c.id LIMIT 101`, a.SubjectID, after)
		if e != nil {
			return nil, e
		}
		defer rows.Close()
		items := []any{}
		var next any
		last := ""
		for rows.Next() {
			var id string
			var intent []byte
			var envelope *string
			var revoked, bindingRevoked *time.Time
			var expiry, bindingExpiry time.Time
			if e = rows.Scan(&id, &intent, &envelope, &revoked, &expiry, &bindingRevoked, &bindingExpiry); e != nil {
				return nil, e
			}
			if len(items) == 100 {
				next = last
				continue
			}
			status := "active"
			if revoked != nil || bindingRevoked != nil {
				status = "revoked"
			} else if min(expiry.Unix(), bindingExpiry.Unix()) <= s.now() {
				status = "expired"
			}
			evidence := "legacy-verified-record"
			if envelope != nil && *envelope != "" {
				evidence = "original-signature-envelope"
			}
			items = append(items, map[string]any{"consentId": id, "intent": json.RawMessage(intent), "signatureEvidence": evidence, "status": status})
			last = id
		}
		if e = rows.Err(); e != nil {
			return nil, e
		}
		return map[string]any{"items": items, "nextCursor": next}, nil
	})
}
