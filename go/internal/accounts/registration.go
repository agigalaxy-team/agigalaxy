// Package accounts operates on the existing registration and account ledgers.
// Its transaction ports require trusted verified callers; they confer no HTTP,
// session, linked-identity, publication or administrator authority themselves.
package accounts

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Service struct {
	Endpoint    string
	Now         func() time.Time
	GenerateUID func() (string, error)
	GenerateID  func() string
}
type Identity struct{ Issuer, ExternalSubject string }
type VerifiedIdentity struct {
	Issuer, ExternalSubject, VerificationMethod string
	VerifiedAt                                  time.Time
}
type Registration struct {
	AccountID, UID, Endpoint, Issuer, ExternalSubject string
	CreatedAt                                         time.Time
}
type Account struct {
	ID, UID string
	Created bool
}

var UIDPattern = regexp.MustCompile(`^G[A-Z0-9]{10}[0-9]$`)
var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Millisecond)
	}
	return time.Now().UTC().Truncate(time.Millisecond)
}
func unavailable() error { return fault.New("official_account_unavailable", 503) }
func GenerateUID() (string, error) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	out := []byte("G00000000000")
	for i := 1; i <= 11; i++ {
		n := int64(36)
		if i == 11 {
			n = 10
		}
		v, e := rand.Int(rand.Reader, big.NewInt(n))
		if e != nil {
			return "", e
		}
		if i == 11 {
			out[i] = '0' + byte(v.Int64())
		} else {
			out[i] = alphabet[v.Int64()]
		}
	}
	return string(out), nil
}

const registrationColumns = `account_id::text,uid,endpoint,issuer,external_subject,created_at`

func scanRegistration(row pgx.Row) (r Registration, e error) {
	e = row.Scan(&r.AccountID, &r.UID, &r.Endpoint, &r.Issuer, &r.ExternalSubject, &r.CreatedAt)
	return
}
func (s *Service) ReserveWithin(ctx context.Context, tx pgx.Tx, input Identity) (Registration, error) {
	return s.reserveAtWithin(ctx, tx, input, s.now())
}
func (s *Service) reserveAtWithin(ctx context.Context, tx pgx.Tx, input Identity, at time.Time) (Registration, error) {
	var empty Registration
	for _, v := range []string{s.Endpoint, input.Issuer, input.ExternalSubject} {
		if protocol.TextLength(v) < 1 || protocol.TextLength(v) > 4096 {
			return empty, unavailable()
		}
	}
	if at.IsZero() {
		return empty, unavailable()
	}
	at = at.UTC().Truncate(time.Millisecond)
	key, e := identity.Canonical([]string{s.Endpoint, input.Issuer, input.ExternalSubject})
	if e != nil {
		return empty, unavailable()
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912467))", string(key)); e != nil {
		return empty, e
	}
	find := func() (Registration, error) {
		return scanRegistration(tx.QueryRow(ctx, "SELECT "+registrationColumns+" FROM official_account_registrations_v1 WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3", s.Endpoint, input.Issuer, input.ExternalSubject))
	}
	existing, e := find()
	if e == nil {
		return existing, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return empty, e
	}
	generate := s.GenerateUID
	if generate == nil {
		generate = GenerateUID
	}
	generateID := s.GenerateID
	if generateID == nil {
		generateID = uuid.NewString
	}
	for attempt := 0; attempt < 32; attempt++ {
		uid, e := generate()
		if e != nil || !UIDPattern.MatchString(uid) {
			return empty, unavailable()
		}
		id := generateID()
		if !uuidPattern.MatchString(id) {
			return empty, unavailable()
		}
		r, e := scanRegistration(tx.QueryRow(ctx, `INSERT INTO official_account_registrations_v1(account_id,uid,endpoint,issuer,external_subject,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING RETURNING `+registrationColumns, id, uid, s.Endpoint, input.Issuer, input.ExternalSubject, at))
		if e == nil {
			return r, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return empty, e
		}
		existing, e = find()
		if e == nil {
			return existing, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return empty, e
		}
	}
	return empty, unavailable()
}

// EnsureAccountWithin follows verified normal creation only. Registration-only
// reservations remain registration-only until this explicit verified call.
func (s *Service) EnsureAccountWithin(ctx context.Context, tx pgx.Tx, input VerifiedIdentity) (Account, error) {
	var out Account
	input.VerifiedAt = input.VerifiedAt.UTC().Truncate(time.Millisecond)
	if input.VerificationMethod != "email" && input.VerificationMethod != "external-account" {
		return out, unavailable()
	}
	reserved, e := s.reserveAtWithin(ctx, tx, Identity{input.Issuer, input.ExternalSubject}, input.VerifiedAt)
	if e != nil {
		return out, e
	}
	e = tx.QueryRow(ctx, `INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING RETURNING id::text,uid`, reserved.AccountID, reserved.UID, s.Endpoint, input.Issuer, input.ExternalSubject, input.VerificationMethod, input.VerifiedAt).Scan(&out.ID, &out.UID)
	if e == nil {
		out.Created = true
		return out, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	e = tx.QueryRow(ctx, `UPDATE community_accounts SET verified_at=$4,verification_method=$5 WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3 AND id=$6 AND uid=$7 RETURNING id::text,uid`, s.Endpoint, input.Issuer, input.ExternalSubject, input.VerifiedAt, input.VerificationMethod, reserved.AccountID, reserved.UID).Scan(&out.ID, &out.UID)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, unavailable()
	}
	return out, e
}
