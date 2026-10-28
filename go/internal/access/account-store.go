package access

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"regexp"
)

var accountUUIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type accountLoginRecord struct {
	Preview   portal.Preview
	ReturnTo  string
	ExpiresAt int64
}

func (g *Gateway) accountLock(ctx context.Context, tx pgx.Tx) error {
	_, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912339,hashtext($1))", g.Config.AccountScope)
	return e
}
func (g *Gateway) createAccountLogin(ctx context.Context, hash string, p portal.Preview, target, previous, observed string) (*portal.Preview, error) {
	u, e := url.Parse(p.AuthorizationURL)
	if e != nil || u.Query().Get("state") == "" || p.ExpiresAt <= g.now() {
		return nil, fault.New("official_account_unavailable", 503)
	}
	raw, e := protocol.Encode(p)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, g.Pool, func(tx pgx.Tx) (*portal.Preview, error) {
		if e := g.accountLock(ctx, tx); e != nil {
			return nil, e
		}
		for _, q := range []string{"DELETE FROM official_account_logins_v1 WHERE scope_hash=$1 AND expires_at<=$2", "DELETE FROM official_account_sessions_v1 WHERE scope_hash=$1 AND (expires_at<=$2 OR revoked_at IS NOT NULL OR idle_expires_at<=$2 OR refresh_state='revoked')"} {
			if _, e := tx.Exec(ctx, q, g.Config.AccountScope, g.now()); e != nil {
				return nil, e
			}
		}
		var pending, active int
		if e := tx.QueryRow(ctx, "SELECT count(*) FROM official_account_logins_v1 WHERE scope_hash=$1 AND status IN ('pending','exchanging')", g.Config.AccountScope).Scan(&pending); e != nil {
			return nil, e
		}
		if e := tx.QueryRow(ctx, "SELECT count(*) FROM official_account_sessions_v1 WHERE scope_hash=$1", g.Config.AccountScope).Scan(&active); e != nil {
			return nil, e
		}
		if pending >= 2048 || active >= 10000 {
			return nil, fault.New("official_account_unavailable", 503)
		}
		var old *portal.Preview
		if previous != "" {
			var b []byte
			e := tx.QueryRow(ctx, "UPDATE official_account_logins_v1 SET status='revoked' WHERE scope_hash=$1 AND login_hash=$2 AND status IN ('pending','exchanging') RETURNING preview", g.Config.AccountScope, previous).Scan(&b)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return nil, e
			}
			if e == nil {
				old = &portal.Preview{}
				if e = json.Unmarshal(b, old); e != nil {
					return nil, e
				}
			}
			var seen any
			if observed != "" {
				seen = observed
			}
			if _, e = tx.Exec(ctx, "UPDATE official_account_sessions_v1 SET revoked_at=$4 WHERE scope_hash=$1 AND login_hash=$2 AND token_hash IS DISTINCT FROM $3 AND revoked_at IS NULL", g.Config.AccountScope, previous, seen, g.now()); e != nil {
				return nil, e
			}
		}
		_, e := tx.Exec(ctx, "INSERT INTO official_account_logins_v1(scope_hash,login_hash,state_hash,preview,return_to,status,created_at,expires_at) VALUES($1,$2,$3,$4,$5,'pending',$6,$7)", g.Config.AccountScope, hash, identity.Digest([]byte(u.Query().Get("state"))), raw, target, g.now(), p.ExpiresAt)
		return old, e
	})
}
func (g *Gateway) claimAccountLogin(ctx context.Context, hash, state string) (accountLoginRecord, error) {
	var r accountLoginRecord
	var raw []byte
	if !scopePattern.MatchString(hash) || state == "" || protocol.TextLength(state) > 512 {
		return r, pgx.ErrNoRows
	}
	e := g.Pool.QueryRow(ctx, "UPDATE official_account_logins_v1 SET status='exchanging' WHERE scope_hash=$1 AND login_hash=$2 AND state_hash=$3 AND expires_at>$4 AND status='pending' RETURNING preview,return_to,expires_at", g.Config.AccountScope, hash, identity.Digest([]byte(state)), g.now()).Scan(&raw, &r.ReturnTo, &r.ExpiresAt)
	if e == nil {
		e = json.Unmarshal(raw, &r.Preview)
	}
	return r, e
}
func (g *Gateway) issueAccountSession(ctx context.Context, loginHash, hash, prior, csrf string, p portal.Principal, age int64) error {
	_, e := postgres.InTx(ctx, g.Pool, func(tx pgx.Tx) (bool, error) {
		if e := g.accountLock(ctx, tx); e != nil {
			return false, e
		}
		var status string
		var expiry int64
		if e := tx.QueryRow(ctx, "SELECT status,expires_at FROM official_account_logins_v1 WHERE scope_hash=$1 AND login_hash=$2 FOR UPDATE", g.Config.AccountScope, loginHash).Scan(&status, &expiry); e != nil {
			return false, e
		}
		if status != "exchanging" || expiry <= g.now() {
			return false, fault.New("official_account_unavailable", 503)
		}
		var count int
		if e := tx.QueryRow(ctx, "SELECT count(*) FROM official_account_sessions_v1 WHERE scope_hash=$1 AND revoked_at IS NULL AND expires_at>$2", g.Config.AccountScope, g.now()).Scan(&count); e != nil {
			return false, e
		}
		if count >= 10000 {
			return false, fault.New("official_account_unavailable", 503)
		}
		data := accounts.Service{Endpoint: g.Config.Endpoint, Now: g.Now}
		method := "external-account"
		if p.EmailVerified {
			method = "email"
		}
		account, e := data.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: p.Issuer, ExternalSubject: p.Subject, VerificationMethod: method, VerifiedAt: time.Unix(g.now(), 0)})
		if e != nil {
			return false, e
		}
		var subjectType *string
		if account.Created {
			v := "person"
			subjectType = &v
		}
		if _, e = data.EnsureProfileWithin(ctx, tx, account.ID, subjectType); e != nil {
			return false, e
		}
		var fenced bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_registered_login_fences_v1 f JOIN official_account_logins_v1 l ON l.scope_hash=f.scope_hash WHERE f.scope_hash=$1 AND f.issuer=$2 AND f.external_subject=$3 AND l.login_hash=$4 AND l.started_at<=f.revoked_before)`, g.Config.AccountScope, p.Issuer, p.Subject, loginHash).Scan(&fenced)
		if e != nil {
			return false, e
		}
		if fenced {
			return false, fault.New("official_account_unavailable", 503)
		}
		if prior != "" {
			if _, e = tx.Exec(ctx, "UPDATE official_account_sessions_v1 SET revoked_at=$3 WHERE scope_hash=$1 AND token_hash=$2 AND revoked_at IS NULL", g.Config.AccountScope, prior, g.now()); e != nil {
				return false, e
			}
		}
		if _, e = tx.Exec(ctx, `INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, g.Config.AccountScope, hash, loginHash, account.ID, p.Issuer, p.Subject, p.Email, p.EmailVerified, csrf, g.now(), g.now()+age); e != nil {
			return false, e
		}
		if g.AccountRenewal != nil {
			if _, e = g.AccountRenewal.Create(ctx, tx, hash, p.Tokens); e != nil {
				return false, e
			}
		}
		_, e = tx.Exec(ctx, "UPDATE official_account_logins_v1 SET status='completed' WHERE scope_hash=$1 AND login_hash=$2", g.Config.AccountScope, loginHash)
		return e == nil, e
	})
	return e
}
func validAccountPrincipal(issuer, subject, expected string) bool {
	return issuer == expected && subject != "" && protocol.TextLength(subject) <= 255 && !strings.ContainsFunc(subject, unicode.IsControl)
}
func (g *Gateway) AccountSessionSummary(ctx context.Context, issuer, subject string) (any, error) {
	if !validAccountPrincipal(issuer, subject, g.Config.AccountIssuer) {
		return nil, fault.New("invalid_account", 400)
	}
	var n int
	e := g.Pool.QueryRow(ctx, `SELECT count(*) FROM official_account_sessions_v1 WHERE scope_hash=$1 AND issuer=$2 AND external_subject=$3 AND revoked_at IS NULL AND expires_at>$4 AND (idle_expires_at IS NULL OR idle_expires_at>$4) AND refresh_state<>'revoked'`, g.Config.AccountScope, issuer, subject, g.now()).Scan(&n)
	return map[string]any{"activeCount": n, "scope": "website-portal"}, e
}
func (g *Gateway) RevokeAccountSessions(ctx context.Context, accountID, issuer, subject string) (any, error) {
	if accountID != "" {
		if !accountUUIDPattern.MatchString(accountID) {
			return nil, fault.New("invalid_account", 400)
		}
		var i, s string
		e := g.Pool.QueryRow(ctx, "SELECT issuer,external_subject FROM community_accounts WHERE id=$1 AND endpoint=$2", accountID, g.Config.Endpoint).Scan(&i, &s)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if e != nil || issuer != "" && i != issuer || subject != "" && s != subject {
			return nil, fault.New("invalid_account", 400)
		}
		issuer, subject = i, s
	}
	if !validAccountPrincipal(issuer, subject, g.Config.AccountIssuer) {
		return nil, fault.New("invalid_account", 400)
	}
	return postgres.InTx(ctx, g.Pool, func(tx pgx.Tx) (any, error) {
		if e := g.accountLock(ctx, tx); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `INSERT INTO operations_registered_login_fences_v1(scope_hash,issuer,external_subject,revoked_before) VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT(scope_hash,issuer,external_subject) DO UPDATE SET revoked_before=GREATEST(operations_registered_login_fences_v1.revoked_before,clock_timestamp())`, g.Config.AccountScope, issuer, subject); e != nil {
			return nil, e
		}
		result, e := tx.Exec(ctx, "UPDATE official_account_sessions_v1 SET revoked_at=$4 WHERE scope_hash=$1 AND issuer=$2 AND external_subject=$3 AND revoked_at IS NULL AND expires_at>$4", g.Config.AccountScope, issuer, subject, g.now())
		if e != nil {
			return nil, e
		}
		return map[string]any{"revokedSessions": result.RowsAffected(), "inflightBlocked": true}, nil
	})
}
