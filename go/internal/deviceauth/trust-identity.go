package deviceauth

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"unicode/utf8"
)

// TrustIdentityWithin is only the original public author-control history.
// The caller separately qualifies the exact signed Trust permission/source.
func (s *Service) TrustIdentityWithin(ctx context.Context, tx pgx.Tx, subject string) (map[string]any, error) {
	var genesis []byte
	e := tx.QueryRow(ctx, "SELECT genesis_proof FROM public.galaxy_api_lock_subject_control($1,false)", subject).Scan(&genesis)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fault.New("trust_identity_unavailable", 404)
	}
	if e != nil {
		return nil, e
	}
	events, e := publicRows(ctx, tx, "SELECT * FROM subject_control_events WHERE subject_id=$1 ORDER BY sequence", subject)
	if e != nil {
		return nil, e
	}
	var proof any
	if json.Unmarshal(genesis, &proof) != nil {
		return nil, controlInvalid()
	}
	return map[string]any{"subjectId": subject, "genesisProof": proof, "events": events, "authority": s.Endpoint, "checkedAt": s.now()}, nil
}

// RequireTrustControlWithin checks the retained grant's specified current key
// and consent scope. A later chain head alone does not invalidate that key.
func (s *Service) RequireTrustControlWithin(ctx context.Context, tx pgx.Tx, subject, keyID string, epoch int64) error {
	_, e := s.CurrentSignerWithin(ctx, tx, subject, nil, &keyID, epoch, "consent")
	return e
}

// VerifyTrustPermissionResponse returns exact signed UTF-8 only for the original Trust permission purpose.
func VerifyTrustPermissionResponse(token, publicKey string) (string, error) {
	_, b, _, _, e := splitCompact(token)
	if e != nil || !utf8.Valid(b) {
		return "", denied()
	}
	raw := string(b)
	if e = verifyTypedResponse(token, raw, publicKey, "galaxy-trust-source-permission-v1+jws"); e != nil {
		return "", e
	}
	return raw, nil
}
