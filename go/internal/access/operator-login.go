package access

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func randomOpaque() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func (g *Gateway) loginProvider(ctx context.Context) (*portal.Login, error) {
	g.loginMu.Lock()
	defer g.loginMu.Unlock()
	if g.operatorLogin != nil {
		return g.operatorLogin, nil
	}
	if g.operatorLoginFactory == nil {
		return nil, fault.New("operations_unavailable", 503)
	}
	p, e := g.operatorLoginFactory(ctx)
	if e != nil {
		return nil, e
	}
	g.operatorLogin = p
	return p, nil
}
func (g *Gateway) loginCookie() string {
	if strings.HasPrefix(g.Config.AdminOrigin, "https:") {
		return "__Host-galaxy-operator-login"
	}
	return "galaxy-operator-login-fixture"
}
func (g *Gateway) setOperatorCookie(w http.ResponseWriter, name, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(g.Config.AdminOrigin, "https:"), SameSite: http.SameSiteLaxMode, MaxAge: age})
}
func (g *Gateway) returnTo(value string) (string, error) {
	if value == "" {
		return g.Config.AdminOrigin + "/admin", nil
	}
	invalid := func(s string) bool { return strings.Contains(s, "\\") || strings.ContainsFunc(s, unicode.IsControl) }
	if protocol.TextLength(value) > 2048 || !strings.HasPrefix(value, "/") || invalid(value) {
		return "", fault.New("operations_access_denied", 403)
	}
	decoded, e := url.PathUnescape(value)
	if e != nil || invalid(decoded) {
		return "", fault.New("operations_access_denied", 403)
	}
	base, _ := url.Parse(g.Config.AdminOrigin)
	relative, e := url.Parse(value)
	if e != nil {
		return "", fault.New("operations_access_denied", 403)
	}
	target := base.ResolveReference(relative)
	if target.Scheme != base.Scheme || target.Host != base.Host || target.User != nil || !(target.Path == "/admin" || strings.HasPrefix(target.Path, "/admin/") || target.Path == "/preview" || strings.HasPrefix(target.Path, "/preview/")) {
		return "", fault.New("operations_access_denied", 403)
	}
	return target.String(), nil
}
func (g *Gateway) beginOperatorLogin(w http.ResponseWriter, r *http.Request) error {
	if _, ok := r.Header["Authorization"]; ok {
		return fault.New("operations_access_denied", 403)
	}
	query, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil || len(query) > 1 || len(query["returnTo"]) > 1 || len(query) == 1 && query["returnTo"] == nil {
		return fault.New("operations_access_denied", 403)
	}
	target, e := g.returnTo(query.Get("returnTo"))
	if e != nil {
		return e
	}
	provider, e := g.loginProvider(r.Context())
	if e != nil {
		return e
	}
	if previous := cookie(r, g.loginCookie()); previous != "" {
		var raw []byte
		e = g.Pool.QueryRow(r.Context(), "UPDATE operations_operator_logins_v1 SET status='revoked' WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3 RETURNING preview", g.Config.Endpoint, g.Config.OperatorConfiguration, identity.Digest([]byte(previous))).Scan(&raw)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if e == nil {
			var p portal.Preview
			if json.Unmarshal(raw, &p) != nil {
				return fault.New("operations_unavailable", 503)
			}
			if e = provider.Cancel(r.Context(), p); e != nil {
				return e
			}
		}
	}
	p, e := provider.Begin(r.Context())
	if e != nil {
		return e
	}
	token, e := randomOpaque()
	if e != nil {
		return e
	}
	raw, e := protocol.Encode(p)
	if e != nil {
		return e
	}
	_, e = postgres.InTx(r.Context(), g.Pool, func(tx pgx.Tx) (bool, error) {
		if _, e := tx.Exec(r.Context(), "DELETE FROM operations_operator_logins_v1 WHERE endpoint=$1 AND configuration_id=$2 AND expires_at<=$3", g.Config.Endpoint, g.Config.OperatorConfiguration, time.Unix(g.now(), 0)); e != nil {
			return false, e
		}
		var n int
		if e := tx.QueryRow(r.Context(), "SELECT count(*) FROM operations_operator_logins_v1 WHERE endpoint=$1 AND configuration_id=$2", g.Config.Endpoint, g.Config.OperatorConfiguration).Scan(&n); e != nil {
			return false, e
		}
		if n >= 2048 {
			return false, fault.New("operations_unavailable", 503)
		}
		_, e := tx.Exec(r.Context(), `INSERT INTO operations_operator_logins_v1(endpoint,configuration_id,token_hash,preview,return_to,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, g.Config.Endpoint, g.Config.OperatorConfiguration, identity.Digest([]byte(token)), raw, target, time.Unix(p.ExpiresAt, 0))
		return e == nil, e
	})
	if e != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = provider.Cancel(ctx, p)
		return e
	}
	g.setOperatorCookie(w, g.loginCookie(), token, 300)
	w.Header().Set("Location", p.AuthorizationURL)
	w.WriteHeader(303)
	return nil
}
func (g *Gateway) completeOperatorLogin(w http.ResponseWriter, r *http.Request) error {
	if _, ok := r.Header["Authorization"]; ok {
		return fault.New("operations_access_denied", 403)
	}
	redirect := func(target string) { w.Header().Set("Location", target); w.WriteHeader(303) }
	token := cookie(r, g.loginCookie())
	hash := identity.Digest([]byte(token))
	query, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil || token == "" || len(query["state"]) != 1 {
		redirect(g.Config.AdminOrigin + "/admin/login?reason=stale")
		return nil
	}
	var raw []byte
	var target string
	e = g.Pool.QueryRow(r.Context(), "SELECT preview,return_to FROM operations_operator_logins_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3", g.Config.Endpoint, g.Config.OperatorConfiguration, hash).Scan(&raw, &target)
	if errors.Is(e, pgx.ErrNoRows) {
		redirect(g.Config.AdminOrigin + "/admin/login?reason=stale")
		return nil
	}
	if e != nil {
		return e
	}
	var p portal.Preview
	if json.Unmarshal(raw, &p) != nil {
		return fault.New("operations_unavailable", 503)
	}
	authorization, e := url.Parse(p.AuthorizationURL)
	if e != nil || query.Get("state") != authorization.Query().Get("state") {
		redirect(g.Config.AdminOrigin + "/admin/login?reason=stale")
		return nil
	}
	result, e := g.Pool.Exec(r.Context(), `UPDATE operations_operator_logins_v1 SET status='exchanging' WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3 AND status='pending' AND expires_at>$4`, g.Config.Endpoint, g.Config.OperatorConfiguration, hash, time.Unix(g.now(), 0))
	if e != nil {
		return e
	}
	if result.RowsAffected() != 1 {
		redirect(g.Config.AdminOrigin + "/admin/login?reason=denied")
		return nil
	}
	provider, e := g.loginProvider(r.Context())
	if e != nil {
		return e
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = provider.Cancel(ctx, p)
	}()
	principal, e := provider.Complete(r.Context(), p, g.Config.AdminOrigin+r.URL.RequestURI())
	if e != nil || principal.Issuer != g.Config.OperatorIssuer || principal.ExpiresAt <= g.now() || !subjectPattern.MatchString(principal.Subject) || !contains(principal.Roles, g.Config.AdministratorRole) && !contains(principal.Roles, g.Config.ReaderRole) {
		redirect(g.Config.AdminOrigin + "/admin/login?reason=denied")
		return nil
	}
	id := identity.Digest([]byte(principal.Issuer + "\x00" + principal.Subject))
	names, e := g.Directory.Roles(r.Context(), principal.Issuer, principal.Subject)
	if e != nil || !contains(names, g.Config.AdministratorRole) && !contains(names, g.Config.ReaderRole) {
		redirect(g.Config.AdminOrigin + "/admin/login?reason=denied")
		return nil
	}
	role := "reader"
	if root := g.Config.Root; root != nil && root.OperatorID == id && root.Issuer == principal.Issuer && root.Subject == principal.Subject {
		role = "administrator"
	}
	sessionToken, e := randomOpaque()
	if e != nil {
		return e
	}
	csrf, e := randomOpaque()
	if e != nil {
		return e
	}
	prior := cookie(r, g.cookie("operator"))
	name := "管理人员"
	if principal.DisplayName != nil && strings.TrimSpace(*principal.DisplayName) != "" {
		name = strings.TrimSpace(*principal.DisplayName)
	}
	age := int64(3600)
	if g.OperatorRenewal != nil && principal.Tokens != nil {
		age = g.OperatorRenewal.Policy.MaximumSeconds
	}
	_, e = postgres.InTx(r.Context(), g.Pool, func(tx pgx.Tx) (bool, error) {
		lock, e := protocol.Encode([]string{g.Config.Endpoint, principal.Issuer, principal.Subject})
		if e != nil {
			return false, e
		}
		if _, e = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1,734912461))", string(lock)); e != nil {
			return false, e
		}
		live, e := g.admitted(r.Context(), tx, session{ID: id, Issuer: principal.Issuer, Subject: principal.Subject})
		if e != nil {
			return false, e
		}
		if !live {
			return false, fault.New("operations_access_denied", 403)
		}
		var state string
		var after bool
		e = tx.QueryRow(r.Context(), `SELECT l.status,coalesce(l.started_at>f.revoked_before,true) FROM operations_operator_logins_v1 l LEFT JOIN operations_management_login_fences_v1 f ON f.endpoint=l.endpoint AND f.issuer=$5 AND f.external_subject=$6 WHERE l.endpoint=$1 AND l.configuration_id=$2 AND l.token_hash=$3 AND l.expires_at>$4 FOR UPDATE OF l`, g.Config.Endpoint, g.Config.OperatorConfiguration, hash, time.Unix(g.now(), 0), principal.Issuer, principal.Subject).Scan(&state, &after)
		if e != nil {
			return false, e
		}
		if state != "exchanging" || !after {
			return false, fault.New("operations_access_denied", 403)
		}
		if _, e = tx.Exec(r.Context(), `INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(operator_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=EXCLUDED.updated_at`, id, g.Config.Endpoint, principal.Issuer, principal.Subject, name, time.Unix(g.now(), 0)); e != nil {
			return false, e
		}
		if prior != "" {
			if _, e = tx.Exec(r.Context(), "DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3", g.Config.Endpoint, g.Config.OperatorConfiguration, identity.Digest([]byte(prior))); e != nil {
				return false, e
			}
		}
		if _, e = tx.Exec(r.Context(), "DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND expires_at<=$3", g.Config.Endpoint, g.Config.OperatorConfiguration, time.Unix(g.now(), 0)); e != nil {
			return false, e
		}
		sessionHash := identity.Digest([]byte(sessionToken))
		if _, e = tx.Exec(r.Context(), `INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, g.Config.Endpoint, g.Config.OperatorConfiguration, sessionHash, id, principal.Issuer, principal.Subject, name, role, csrf, time.Unix(g.now()+age, 0)); e != nil {
			return false, e
		}
		if g.OperatorRenewal != nil {
			if _, e = g.OperatorRenewal.Create(r.Context(), tx, sessionHash, principal.Tokens); e != nil {
				return false, e
			}
		}
		_, e = tx.Exec(r.Context(), "UPDATE operations_operator_logins_v1 SET status='completed' WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3", g.Config.Endpoint, g.Config.OperatorConfiguration, hash)
		return e == nil, e
	})
	if e != nil {
		redirect(g.Config.AdminOrigin + "/admin/login?reason=denied")
		return nil
	}
	// A newer tab may have replaced its login cookie while token exchange ran.
	// Set only the new session cookie, never clear a possibly newer login cookie.
	g.setOperatorCookie(w, g.cookie("operator"), sessionToken, int(age))
	redirect(target)
	return nil
}
