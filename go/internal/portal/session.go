package portal

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type RefreshRequest struct{ Token, Issuer, Subject string }
type Tokens struct {
	RefreshToken string
	ExpiresAt    int64
}

// Provider must retain the original issuer/subject validation and token
// endpoint authentication. An unknown response is never exchanged again.
type Provider interface {
	Refresh(context.Context, RefreshRequest) (Tokens, error)
}
type Sessions struct {
	Pool     *pgxpool.Pool
	Kind     string
	Scope    []string
	Policy   Policy
	Provider Provider
	Now      func() time.Time
}
type Row struct {
	TokenHash, Issuer, Subject, RefreshCipher, RefreshState string
	Version                                                 int
	UpstreamExpires, IdleExpires, MaxExpires                int64
}
type Live struct {
	Renewable, Active bool
	ExpiresAt         int64
}

var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func New(pool *pgxpool.Pool, kind string, scope []string, policy Policy, provider Provider) (*Sessions, error) {
	if e := policy.Validate(); e != nil {
		return nil, e
	}
	if kind != "account" && kind != "operator" || kind == "account" && len(scope) != 1 || kind == "operator" && len(scope) != 2 {
		return nil, fault.New("portal_scope_invalid", 400)
	}
	for _, part := range scope {
		if part == "" {
			return nil, fault.New("portal_scope_invalid", 400)
		}
	}
	return &Sessions{Pool: pool, Kind: kind, Scope: append([]string(nil), scope...), Policy: policy, Provider: provider}, nil
}
func (s *Sessions) stamp() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Sessions) table() string {
	if s.Kind == "account" {
		return "official_account_sessions_v1"
	}
	return "operations_operator_sessions_v1"
}
func (s *Sessions) where() string {
	if s.Kind == "account" {
		return "scope_hash=$1 AND token_hash=$2"
	}
	return "endpoint=$1 AND configuration_id=$2 AND token_hash=$3"
}
func (s *Sessions) args(hash string) []any {
	p := []any{}
	for _, part := range s.Scope {
		p = append(p, part)
	}
	return append(p, hash)
}
func (s *Sessions) live() string {
	if s.Kind == "account" {
		return " AND revoked_at IS NULL"
	}
	return ""
}

const fields = `token_hash,issuer,external_subject,coalesce(refresh_cipher,''),refresh_state,refresh_version,
 coalesce(upstream_expires_at,0),coalesce(idle_expires_at,0),coalesce(max_expires_at,0)`

func scan(row pgx.Row) (r Row, e error) {
	e = row.Scan(&r.TokenHash, &r.Issuer, &r.Subject, &r.RefreshCipher, &r.RefreshState, &r.Version, &r.UpstreamExpires, &r.IdleExpires, &r.MaxExpires)
	return
}
func (s *Sessions) Read(ctx context.Context, hash string) (Row, error) {
	if !hashPattern.MatchString(hash) {
		return Row{}, fault.New("portal_session_invalid", 401)
	}
	return scan(s.Pool.QueryRow(ctx, "SELECT "+fields+" FROM "+s.table()+" WHERE "+s.where()+s.live(), s.args(hash)...))
}
func (s *Sessions) Current(ctx context.Context, row Row, activity bool) (Live, error) {
	if !hashPattern.MatchString(row.TokenHash) {
		return Live{}, fault.New("portal_session_invalid", 401)
	}
	if row.RefreshCipher == "" {
		return Live{Renewable: false, Active: true}, nil
	}
	p := s.args(row.TokenHash)
	n := len(p)
	at := s.stamp()
	table, where, live := s.table(), s.where(), s.live()
	if row.RefreshState == "revoked" || row.IdleExpires <= at || row.MaxExpires <= at {
		return Live{Renewable: true}, nil
	}
	if activity {
		args := append(append([]any(nil), p...), at+s.Policy.IdleSeconds, at)
		var e error
		row, e = scan(s.Pool.QueryRow(ctx, fmt.Sprintf("UPDATE %s SET idle_expires_at=LEAST(max_expires_at,$%d) WHERE %s%s AND refresh_state<>'revoked' AND idle_expires_at>$%d AND max_expires_at>$%d RETURNING %s", table, n+1, where, live, n+2, n+2, fields), args...))
		if errors.Is(e, pgx.ErrNoRows) {
			return Live{Renewable: true}, nil
		}
		if e != nil {
			return Live{}, e
		}
	}
	if row.UpstreamExpires > at+s.Policy.RefreshBeforeSeconds {
		return Live{Renewable: true, Active: true, ExpiresAt: min(row.IdleExpires, row.MaxExpires)}, nil
	}
	if row.RefreshState != "ready" || s.Provider == nil {
		return Live{}, fault.New("portal_session_refresh_unconfirmed", 503)
	}
	args := append(append([]any(nil), p...), row.Version, at)
	claim, e := scan(s.Pool.QueryRow(ctx, fmt.Sprintf("UPDATE %s SET refresh_state='refreshing',refresh_version=refresh_version+1 WHERE %s%s AND refresh_version=$%d AND refresh_state='ready' AND idle_expires_at>$%d AND max_expires_at>$%d RETURNING %s", table, where, live, n+1, n+2, n+2, fields), args...))
	if errors.Is(e, pgx.ErrNoRows) {
		return Live{}, fault.New("portal_session_refresh_unconfirmed", 503)
	}
	if e != nil {
		return Live{}, e
	}
	// This claim is committed before the external token exchange. Do not wrap
	// the provider call in a transaction whose rollback would allow replay.
	secret, e := s.Decrypt(claim.RefreshCipher, row.TokenHash)
	var refreshed Tokens
	if e == nil {
		refreshed, e = s.Provider.Refresh(ctx, RefreshRequest{Token: secret, Issuer: claim.Issuer, Subject: claim.Subject})
	}
	if e == nil && (refreshed.RefreshToken == "" || refreshed.ExpiresAt <= s.stamp()) {
		e = fault.New("portal_session_refresh_unconfirmed", 503)
	}
	if e != nil {
		return s.failed(ctx, p, n, claim.Version, e)
	}
	cipher, e := s.Encrypt(refreshed.RefreshToken, row.TokenHash)
	if e != nil {
		return s.failed(ctx, p, n, claim.Version, e)
	}
	args = append(append([]any(nil), p...), claim.Version, cipher, refreshed.ExpiresAt, s.stamp())
	updated, e := scan(s.Pool.QueryRow(ctx, fmt.Sprintf("UPDATE %s SET refresh_state='ready',refresh_cipher=$%d,upstream_expires_at=$%d WHERE %s%s AND refresh_version=$%d AND refresh_state='refreshing' AND idle_expires_at>$%d AND max_expires_at>$%d RETURNING %s", table, n+2, n+3, where, live, n+1, n+4, n+4, fields), args...))
	if errors.Is(e, pgx.ErrNoRows) {
		return Live{Renewable: true}, nil
	}
	if e != nil {
		return Live{}, e
	}
	return Live{Renewable: true, Active: true, ExpiresAt: min(updated.IdleExpires, updated.MaxExpires)}, nil
}
func (s *Sessions) failed(ctx context.Context, p []any, n, version int, cause error) (Live, error) {
	state := "unknown"
	if fault.Code(cause) == "portal_refresh_rejected" {
		state = "revoked"
	}
	// Even after request cancellation, persist the unknown/revoked marker with
	// a bounded cleanup context; never turn an unknown exchange back to ready.
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	args := append(append([]any(nil), p...), version, state)
	_, e := s.Pool.Exec(cleanup, fmt.Sprintf("UPDATE %s SET refresh_state=$%d WHERE %s%s AND refresh_version=$%d AND refresh_state='refreshing'", s.table(), n+2, s.where(), s.live(), n+1), args...)
	if e != nil {
		return Live{}, fault.New("portal_session_refresh_unconfirmed", 503)
	}
	if state == "revoked" {
		query := "DELETE FROM " + s.table() + " WHERE " + s.where() + " AND refresh_state='revoked'"
		args = p
		if s.Kind == "account" {
			query = fmt.Sprintf("UPDATE %s SET revoked_at=$%d WHERE %s AND refresh_state='revoked'", s.table(), n+1, s.where())
			args = append(append([]any(nil), p...), s.stamp())
		}
		if _, e = s.Pool.Exec(cleanup, query, args...); e != nil {
			return Live{}, fault.New("portal_session_refresh_unconfirmed", 503)
		}
		return Live{Renewable: true}, nil
	}
	return Live{}, fault.New("portal_session_refresh_unconfirmed", 503)
}
