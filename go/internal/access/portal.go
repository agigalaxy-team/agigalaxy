// Package access owns portal-cookie authentication and the current human
// authority used by migrated business domains. It does not issue new identities.
package access

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Directory interface {
	Roles(context.Context, string, string) ([]string, error)
}
type Root struct{ OperatorID, Issuer, Subject string }
type Config struct {
	Endpoint, WebsiteOrigin, AdminOrigin string
	AccountIssuer, OperatorIssuer        string
	AccountScope, OperatorConfiguration  string
	AdministratorRole, ReaderRole        string
	Root                                 *Root
	AllowLoopbackHTTP                    bool
}
type Gateway struct {
	Pool                            *pgxpool.Pool
	Config                          Config
	Directory                       Directory
	AccountRenewal, OperatorRenewal *portal.Sessions
	Now                             func() time.Time
}
type session struct {
	ID, Issuer, Subject, CSRF, Hash string
	Renewable                       bool
}
type bound struct {
	gateway        *Gateway
	kind, hash, id string
}

var opaquePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var scopePattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var rolePattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func New(pool *pgxpool.Pool, c Config, d Directory) (*Gateway, error) {
	for _, value := range []string{c.Endpoint, c.WebsiteOrigin, c.AdminOrigin} {
		u, e := url.Parse(value)
		if e != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Scheme != "https" && !(c.AllowLoopbackHTTP && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
			return nil, fault.New("portal_configuration_invalid", 400)
		}
	}
	if c.AccountIssuer == "" || c.OperatorIssuer == "" || c.AccountIssuer == c.OperatorIssuer || !scopePattern.MatchString(c.AccountScope) || !scopePattern.MatchString(c.OperatorConfiguration) || !rolePattern.MatchString(c.AdministratorRole) || !rolePattern.MatchString(c.ReaderRole) || c.AdministratorRole == c.ReaderRole {
		return nil, fault.New("portal_configuration_invalid", 400)
	}
	if c.Root != nil && (c.Root.Issuer != c.OperatorIssuer || c.Root.Subject == "" || c.Root.OperatorID != identity.Digest([]byte(c.Root.Issuer+"\x00"+c.Root.Subject))) {
		return nil, fault.New("operations_root_principal_invalid", 400)
	}
	if c.Root != nil {
		root := *c.Root
		c.Root = &root
	}
	return &Gateway{Pool: pool, Config: c, Directory: d}, nil
}
func (g *Gateway) now() int64 {
	if g.Now != nil {
		return g.Now().Unix()
	}
	return time.Now().Unix()
}
func (g *Gateway) cookie(kind string) string {
	origin := g.Config.Endpoint
	if kind == "operator" {
		origin = g.Config.AdminOrigin
	}
	if strings.HasPrefix(origin, "https:") {
		if kind == "account" {
			return "__Host-galaxy-account"
		}
		return "__Host-galaxy-operator"
	}
	if kind == "account" {
		return "galaxy-account-fixture"
	}
	return "galaxy-operator-fixture"
}
func cookie(r *http.Request, name string) string {
	value := ""
	count := 0
	for _, c := range r.Cookies() {
		if c.Name == name {
			count++
			value = c.Value
		}
	}
	if count != 1 || !opaquePattern.MatchString(value) {
		return ""
	}
	return value
}
func equal(a, b string) bool {
	return opaquePattern.MatchString(a) && opaquePattern.MatchString(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func header(r *http.Request, key string) string {
	v := r.Header.Values(key)
	if len(v) != 1 {
		return ""
	}
	return v[0]
}
func (g *Gateway) origin(r *http.Request, kind string, write bool) bool {
	origin := g.Config.WebsiteOrigin
	if kind == "operator" {
		origin = g.Config.AdminOrigin
	}
	if header(r, "Origin") == origin {
		return true
	}
	u, e := url.Parse(origin)
	if e != nil {
		return false
	}
	return !write && r.Method == "GET" && len(r.Header.Values("Origin")) == 0 && header(r, "Sec-Fetch-Site") == "same-origin" && r.Host == u.Host && (kind == "operator" || g.Config.Endpoint == origin)
}

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (g *Gateway) row(ctx context.Context, db queryer, kind, hash string) (session, error) {
	var r session
	r.Hash = hash
	var cipher *string
	if kind == "account" {
		e := db.QueryRow(ctx, `SELECT s.account_id::text,s.issuer,s.external_subject,s.csrf_token,s.refresh_cipher FROM official_account_sessions_v1 s
		 JOIN community_accounts a ON a.id=s.account_id AND a.endpoint=$3 AND a.issuer=s.issuer AND a.external_subject=s.external_subject
		 WHERE s.scope_hash=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>$4 AND s.refresh_state<>'revoked'
		 AND (s.idle_expires_at IS NULL OR s.idle_expires_at>$4) AND (s.max_expires_at IS NULL OR s.max_expires_at>$4)`, g.Config.AccountScope, hash, g.Config.Endpoint, g.now()).Scan(&r.ID, &r.Issuer, &r.Subject, &r.CSRF, &cipher)
		r.Renewable = cipher != nil && *cipher != ""
		return r, e
	}
	e := db.QueryRow(ctx, `SELECT s.operator_id,s.issuer,s.external_subject,s.csrf_token,s.refresh_cipher FROM operations_operator_sessions_v1 s
	 WHERE s.endpoint=$1 AND s.configuration_id=$2 AND s.token_hash=$3 AND s.expires_at>$4 AND s.refresh_state<>'revoked'
	 AND (s.idle_expires_at IS NULL OR s.idle_expires_at>$5) AND (s.max_expires_at IS NULL OR s.max_expires_at>$5)`, g.Config.Endpoint, g.Config.OperatorConfiguration, hash, time.Unix(g.now(), 0), g.now()).Scan(&r.ID, &r.Issuer, &r.Subject, &r.CSRF, &cipher)
	r.Renewable = cipher != nil && *cipher != ""
	return r, e
}
func (g *Gateway) authenticate(r *http.Request, kind string, write bool) (session, error) {
	if _, ok := r.Header["Authorization"]; ok {
		return session{}, fault.New("access_denied", 401)
	}
	if !g.origin(r, kind, write) {
		code := "account_csrf_invalid"
		if kind == "operator" {
			code = "operations_csrf_invalid"
		}
		return session{}, fault.New(code, 403)
	}
	token := cookie(r, g.cookie(kind))
	if token == "" {
		return session{}, loginRequired(kind)
	}
	row, e := g.row(r.Context(), g.Pool, kind, identity.Digest([]byte(token)))
	if errors.Is(e, pgx.ErrNoRows) {
		return row, loginRequired(kind)
	}
	if e != nil {
		return row, e
	}
	expectedIssuer := g.Config.AccountIssuer
	if kind == "operator" {
		expectedIssuer = g.Config.OperatorIssuer
	}
	if row.Issuer != expectedIssuer {
		return row, loginRequired(kind)
	}
	csrf := "X-Galaxy-Account-CSRF"
	if kind == "operator" {
		csrf = "X-Galaxy-Operator-CSRF"
	}
	if write && !equal(header(r, csrf), row.CSRF) {
		code := "operations_access_denied"
		if kind == "account" {
			code = "account_csrf_invalid"
		}
		return row, fault.New(code, 403)
	}
	if kind == "account" && header(r, "X-Galaxy-Account-ID") != row.ID {
		return row, fault.New("official_account_changed", 409)
	}
	if row.Renewable {
		renewal := g.AccountRenewal
		if kind == "operator" {
			renewal = g.OperatorRenewal
		}
		if renewal == nil {
			return row, fault.New("portal_session_refresh_unconfirmed", 503)
		}
		original, e := renewal.Read(r.Context(), row.Hash)
		if e != nil {
			return row, e
		}
		activity := header(r, "X-Galaxy-User-Activity") == "1" && equal(header(r, csrf), row.CSRF)
		live, e := renewal.Current(r.Context(), original, activity)
		if e != nil {
			return row, e
		}
		if !live.Active {
			return row, loginRequired(kind)
		}
	}
	return row, nil
}
func loginRequired(kind string) error {
	if kind == "account" {
		return fault.New("official_account_login_required", 401)
	}
	return fault.New("operations_login_required", 401)
}
func (g *Gateway) Account(r *http.Request, write bool) (string, feedback.Authorization, error) {
	s, e := g.authenticate(r, "account", write)
	if e != nil {
		return "", nil, e
	}
	return s.ID, &bound{g, "account", s.Hash, s.ID}, nil
}
func (g *Gateway) Operator(r *http.Request, write bool, permission string) (string, feedback.Authorization, error) {
	s, e := g.authenticate(r, "operator", write)
	if e != nil {
		return "", nil, e
	}
	allowed, e := g.admitted(r.Context(), g.Pool, s)
	if e != nil {
		return "", nil, e
	}
	if !allowed {
		_, e = g.Pool.Exec(r.Context(), "DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3", g.Config.Endpoint, g.Config.OperatorConfiguration, s.Hash)
		if e != nil {
			return "", nil, e
		}
		return "", nil, loginRequired("operator")
	}
	if permission != "feedback.read" && permission != "feedback.update" {
		return "", nil, fault.New("operations_permission_unknown", 403)
	}
	return s.ID, &bound{g, "operator", s.Hash, s.ID}, nil
}
func (b *bound) Account(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	if b.kind != "account" || endpoint != b.gateway.Config.Endpoint || id != b.id {
		return loginRequired("account")
	}
	r, e := b.gateway.row(ctx, tx, "account", b.hash)
	if errors.Is(e, pgx.ErrNoRows) {
		return loginRequired("account")
	}
	if e != nil {
		return e
	}
	if r.ID != id || r.Issuer != b.gateway.Config.AccountIssuer {
		return loginRequired("account")
	}
	return nil
}
func (b *bound) Operator(ctx context.Context, tx pgx.Tx, endpoint, id, permission string) (feedback.Operator, error) {
	if b.kind != "operator" || endpoint != b.gateway.Config.Endpoint || id != b.id {
		return feedback.Operator{}, fault.New("business_admin_denied", 403)
	}
	r, e := b.gateway.row(ctx, tx, "operator", b.hash)
	if errors.Is(e, pgx.ErrNoRows) {
		return feedback.Operator{}, loginRequired("operator")
	}
	if e != nil {
		return feedback.Operator{}, e
	}
	if r.ID != id || r.Issuer != b.gateway.Config.OperatorIssuer || id != identity.Digest([]byte(r.Issuer+"\x00"+r.Subject)) {
		return feedback.Operator{}, fault.New("business_admin_denied", 403)
	}
	return b.gateway.authorize(ctx, tx, r, permission)
}
