package access

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

var accountGUIDPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)

func (g *Gateway) accountProvider(ctx context.Context) (*portal.Login, error) {
	g.loginMu.Lock()
	defer g.loginMu.Unlock()
	if g.accountLogin != nil {
		return g.accountLogin, nil
	}
	if g.accountLoginFactory == nil {
		return nil, fault.New("official_account_unavailable", 503)
	}
	p, e := g.accountLoginFactory(ctx)
	if e != nil {
		return nil, fault.New("official_account_unavailable", 503)
	}
	g.accountLogin = p
	return p, nil
}
func (g *Gateway) accountLoginCookie() string {
	if strings.HasPrefix(g.Config.Endpoint, "https:") {
		return "__Host-galaxy-account-login"
	}
	return "galaxy-account-login-fixture"
}
func (g *Gateway) setAccountCookie(w http.ResponseWriter, name, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(g.Config.Endpoint, "https:"), SameSite: http.SameSiteLaxMode, MaxAge: age})
}
func (g *Gateway) accountReturn(value string, present bool) (string, error) {
	if !present {
		return g.Config.WebsiteOrigin + "/app/account", nil
	}
	invalid := func(s string) bool { return strings.Contains(s, "\\") || strings.ContainsFunc(s, unicode.IsControl) }
	if protocol.TextLength(value) > 2048 || !strings.HasPrefix(value, "/app/") || invalid(value) {
		return "", fault.New("invalid_account_return", 400)
	}
	decoded, e := url.PathUnescape(value)
	if e != nil || !utf8.ValidString(decoded) || invalid(decoded) {
		return "", fault.New("invalid_account_return", 400)
	}
	base, _ := url.Parse(g.Config.WebsiteOrigin)
	rel, e := url.Parse(value)
	if e != nil {
		return "", fault.New("invalid_account_return", 400)
	}
	// WHATWG removes literal and encoded dot segments but retains empty ones.
	// path.Clean would change meaningful double slashes in the original target.
	segments := strings.Split(rel.EscapedPath(), "/")[1:]
	normalized := []string{}
	for i, segment := range segments {
		decoded, _ := url.PathUnescape(segment)
		switch decoded {
		case ".":
			if i == len(segments)-1 {
				normalized = append(normalized, "")
			}
		case "..":
			if len(normalized) > 0 {
				normalized = normalized[:len(normalized)-1]
			}
			if i == len(segments)-1 {
				normalized = append(normalized, "")
			}
		default:
			normalized = append(normalized, segment)
		}
	}
	normalizedURL, e := url.Parse("/" + strings.Join(normalized, "/"))
	if e != nil {
		return "", fault.New("invalid_account_return", 400)
	}
	u := *base
	u.Path, u.RawPath = normalizedURL.Path, normalizedURL.RawPath
	u.RawQuery, u.ForceQuery, u.Fragment, u.RawFragment = accountURLQuery(rel.RawQuery), rel.ForceQuery, rel.Fragment, rel.RawFragment
	if u.Scheme != base.Scheme || u.Host != base.Host || !strings.HasPrefix(u.Path, "/app/") {
		return "", fault.New("invalid_account_return", 400)
	}
	return u.String(), nil
}

// net/url keeps RawQuery unchanged; browser URL serializes Unicode and the
// special-URL query characters without decoding/reordering existing parameters.
func accountURLQuery(raw string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c <= 0x20 || c > 0x7e || strings.ContainsRune("\"#<>'", rune(c)) {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// Registration stays on this issuer's native endpoint and retains OIDC state/PKCE.
func (g *Gateway) accountRegistrationURL(authorization string) (string, error) {
	u, e := url.Parse(authorization)
	issuer, ie := url.Parse(g.Config.AccountIssuer)
	if e != nil || ie != nil || u.User != nil || u.Scheme != issuer.Scheme || u.Host != issuer.Host || u.EscapedPath() != strings.TrimSuffix(issuer.EscapedPath(), "/")+"/protocol/openid-connect/auth" {
		return "", fault.New("official_account_unavailable", 503)
	}
	u.Path = strings.TrimSuffix(u.Path, "/auth") + "/registrations"
	u.RawPath = ""
	return u.String(), nil
}
func accountRedirect(w http.ResponseWriter, target string) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Location", target)
	w.WriteHeader(303)
}
func hashCookie(r *http.Request, name string) string {
	if token := cookie(r, name); token != "" {
		return identity.Digest([]byte(token))
	}
	return ""
}
func (g *Gateway) beginAccountLogin(w http.ResponseWriter, r *http.Request) error {
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return fault.New("invalid_account_login", 400)
	}
	for k, v := range q {
		if (k != "mode" && k != "returnTo") || len(v) != 1 {
			return fault.New("invalid_account_login", 400)
		}
	}
	mode := q.Get("mode")
	if _, ok := q["mode"]; !ok {
		mode = "login"
	}
	if mode != "login" && mode != "register" {
		return fault.New("invalid_account_login", 400)
	}
	_, present := q["returnTo"]
	target, e := g.accountReturn(q.Get("returnTo"), present)
	if e != nil {
		return e
	}
	provider, e := g.accountProvider(r.Context())
	if e != nil {
		return e
	}
	p, e := provider.Begin(r.Context())
	if e != nil {
		return fault.New("official_account_unavailable", 503)
	}
	cancel := func(preview portal.Preview) {
		ctx, done := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer done()
		_ = provider.Cancel(ctx, preview)
	}
	authorization := p.AuthorizationURL
	if mode == "register" {
		authorization, e = g.accountRegistrationURL(authorization)
		if e != nil {
			cancel(p)
			return e
		}
	}
	token, e := randomOpaque()
	if e != nil {
		cancel(p)
		return e
	}
	old, e := g.createAccountLogin(r.Context(), identity.Digest([]byte(token)), p, target, hashCookie(r, g.accountLoginCookie()), hashCookie(r, g.cookie("account")))
	if e != nil {
		cancel(p)
		return fault.New("official_account_unavailable", 503)
	}
	if old != nil {
		cancel(*old)
	}
	g.setAccountCookie(w, g.accountLoginCookie(), token, 300)
	accountRedirect(w, authorization)
	return nil
}
func (g *Gateway) completeAccountLogin(w http.ResponseWriter, r *http.Request) error {
	q, e := url.ParseQuery(r.URL.RawQuery)
	hash := hashCookie(r, g.accountLoginCookie())
	if e != nil || hash == "" || len(q["state"]) != 1 {
		accountRedirect(w, g.Config.WebsiteOrigin+"/app/account?accountLogin=stale")
		return nil
	}
	record, e := g.claimAccountLogin(r.Context(), hash, q.Get("state"))
	if errors.Is(e, pgx.ErrNoRows) {
		accountRedirect(w, g.Config.WebsiteOrigin+"/app/account?accountLogin=stale")
		return nil
	}
	if e != nil {
		return e
	}
	target := record.ReturnTo
	run := func() error {
		provider, e := g.accountProvider(r.Context())
		if e != nil {
			return e
		}
		defer func() {
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			defer cancel()
			_ = provider.Cancel(ctx, record.Preview)
		}()
		p, e := provider.Complete(r.Context(), record.Preview, g.Config.Endpoint+r.URL.RequestURI())
		if e != nil {
			return e
		}
		if !validAccountPrincipal(p.Issuer, p.Subject, g.Config.AccountIssuer) || p.ClientID != g.Config.AccountClientID || p.ExpiresAt <= g.now() {
			return fault.New("official_account_unavailable", 503)
		}
		token, e := randomOpaque()
		if e != nil {
			return e
		}
		csrf, e := randomOpaque()
		if e != nil {
			return e
		}
		age := int64(3600)
		if g.AccountRenewal != nil && p.Tokens != nil && p.Tokens.RefreshToken != "" {
			age = g.AccountRenewal.Policy.MaximumSeconds
		}
		if e = g.issueAccountSession(r.Context(), hash, identity.Digest([]byte(token)), hashCookie(r, g.cookie("account")), csrf, p, age); e != nil {
			return e
		}
		g.setAccountCookie(w, g.cookie("account"), token, int(age))
		return nil
	}
	if e = run(); e != nil {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		if _, err := g.Pool.Exec(ctx, "UPDATE official_account_logins_v1 SET status='revoked' WHERE scope_hash=$1 AND login_hash=$2 AND status='exchanging'", g.Config.AccountScope, hash); err != nil {
			return err
		}
		u, _ := url.Parse(target)
		values := u.Query()
		reason := "failed"
		if q.Get("error") == "access_denied" {
			reason = "cancelled"
		}
		values.Set("accountLogin", reason)
		u.RawQuery = values.Encode()
		target = u.String()
	}
	accountRedirect(w, target)
	return nil
}
func accountSignedOut() any {
	return map[string]any{"state": "signed-out", "galaxyAuthorization": false}
}
func (g *Gateway) readAccountSession(r *http.Request, renew bool) (session, int64, error) {
	hash := hashCookie(r, g.cookie("account"))
	if hash == "" {
		return session{}, 0, pgx.ErrNoRows
	}
	s := session{Hash: hash}
	var expiry int64
	var cipher *string
	e := g.Pool.QueryRow(r.Context(), `SELECT account_id::text,issuer,external_subject,csrf_token,expires_at,refresh_cipher FROM official_account_sessions_v1 WHERE scope_hash=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>$3`, g.Config.AccountScope, hash, g.now()).Scan(&s.ID, &s.Issuer, &s.Subject, &s.CSRF, &expiry, &cipher)
	if e != nil {
		return s, 0, e
	}
	if s.Issuer != g.Config.AccountIssuer {
		return s, 0, pgx.ErrNoRows
	}
	s.Renewable = cipher != nil && *cipher != ""
	if renew && s.Renewable {
		if g.AccountRenewal == nil {
			return s, 0, pgx.ErrNoRows
		}
		row, e := g.AccountRenewal.Read(r.Context(), hash)
		if e != nil {
			return s, 0, e
		}
		activity := header(r, "X-Galaxy-User-Activity") == "1" && g.origin(r, "account", false) && equal(header(r, "X-Galaxy-Account-CSRF"), s.CSRF)
		live, e := g.AccountRenewal.Current(r.Context(), row, activity)
		if e != nil {
			return s, 0, e
		}
		if !live.Active {
			return s, 0, pgx.ErrNoRows
		}
		if live.Renewable {
			expiry = live.ExpiresAt
		}
	}
	return s, expiry, nil
}
func (g *Gateway) accountSession(r *http.Request) (any, error) {
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil || len(q) > 1 || len(q["after"]) > 1 || len(q) == 1 && q["after"] == nil {
		return nil, fault.New("invalid_account_query", 400)
	}
	after := q.Get("after")
	if after != "" && !accountGUIDPattern.MatchString(after) {
		return nil, fault.New("invalid_account_query", 400)
	}
	s, expiry, e := g.readAccountSession(r, true)
	if errors.Is(e, pgx.ErrNoRows) {
		return accountSignedOut(), nil
	}
	if e != nil {
		return nil, e
	}
	var cursor any
	if _, ok := q["after"]; ok {
		cursor = after
	}
	rows, e := g.Pool.Query(r.Context(), `SELECT l.subject_id,MIN(l.created_at) FROM external_identity_links l JOIN community_account_links g ON g.identity_link_id=l.id JOIN community_accounts a ON a.id=g.account_id WHERE a.endpoint=$1 AND a.issuer=$2 AND a.external_subject=$3 AND l.endpoint=$1 AND l.issuer=$2 AND l.external_subject=$3 AND l.client_id=ANY($4::text[]) AND l.revoked_at IS NULL AND ($5::text IS NULL OR l.subject_id>$5) GROUP BY l.subject_id ORDER BY l.subject_id LIMIT 101`, g.Config.Endpoint, s.Issuer, s.Subject, g.Config.AssociationClients, cursor)
	if e != nil {
		return nil, e
	}
	links := []any{}
	var next any
	last := ""
	for rows.Next() {
		var id string
		var at time.Time
		if e = rows.Scan(&id, &at); e != nil {
			rows.Close()
			return nil, e
		}
		if len(links) < 100 {
			links = append(links, map[string]any{"subjectId": id, "linkedAt": at.UTC().Format("2006-01-02T15:04:05.000Z")})
			last = id
		} else {
			next = last
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	profile, e := postgres.InTx(r.Context(), g.Pool, func(tx pgx.Tx) (accounts.Profile, error) {
		data := accounts.Service{Endpoint: g.Config.Endpoint, Now: g.Now}
		return data.EnsureProfileWithin(r.Context(), tx, s.ID, nil)
	})
	if e != nil {
		return nil, e
	}
	var email *string
	var verified bool
	if e = g.Pool.QueryRow(r.Context(), "SELECT email,email_verified FROM official_account_sessions_v1 WHERE scope_hash=$1 AND token_hash=$2", g.Config.AccountScope, s.Hash).Scan(&email, &verified); e != nil {
		return nil, e
	}
	return map[string]any{"state": "signed-in", "account": map[string]any{"id": s.ID, "uid": profile.UID, "displayName": profile.DisplayName, "avatarKey": profile.AvatarKey, "subjectType": profile.SubjectType, "email": email, "emailVerified": verified}, "linkedIds": links, "nextAfter": next, "expiresAt": expiry, "csrfToken": s.CSRF, "galaxyAuthorization": false}, nil
}
func (g *Gateway) accountLogout(w http.ResponseWriter, r *http.Request) (any, error) {
	if _, ok := r.Header["Authorization"]; ok {
		return nil, fault.New("access_denied", 401)
	}
	s, _, e := g.readAccountSession(r, false)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	if !g.origin(r, "account", true) || e != nil || !equal(header(r, "X-Galaxy-Account-CSRF"), s.CSRF) {
		return nil, fault.New("account_csrf_invalid", 403)
	}
	login := hashCookie(r, g.accountLoginCookie())
	_, e = postgres.InTx(r.Context(), g.Pool, func(tx pgx.Tx) (bool, error) {
		if login != "" {
			if _, e := tx.Exec(r.Context(), "UPDATE official_account_logins_v1 SET status='revoked' WHERE scope_hash=$1 AND login_hash=$2 AND status IN ('pending','exchanging')", g.Config.AccountScope, login); e != nil {
				return false, e
			}
		}
		var hash any
		if login != "" {
			hash = login
		}
		_, e := tx.Exec(r.Context(), "UPDATE official_account_sessions_v1 SET revoked_at=$4 WHERE scope_hash=$1 AND (token_hash=$2 OR login_hash=$3) AND revoked_at IS NULL", g.Config.AccountScope, s.Hash, hash, g.now())
		return e == nil, e
	})
	if e != nil {
		return nil, e
	}
	g.setAccountCookie(w, g.cookie("account"), "", -1)
	g.setAccountCookie(w, g.accountLoginCookie(), "", -1)
	return accountSignedOut(), nil
}
