package access

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (g *Gateway) SessionHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if (path == "/v1/operations/login" || path == "/v1/operations/callback" || path == "/v1/account/login" || path == "/v1/account/callback") && r.Method == "GET" {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			var e error
			if path == "/v1/account/login" {
				e = g.beginAccountLogin(w, r)
			} else if path == "/v1/account/callback" {
				e = g.completeAccountLogin(w, r)
			} else if path == "/v1/operations/login" {
				e = g.beginOperatorLogin(w, r)
			} else {
				e = g.completeOperatorLogin(w, r)
			}
			if e != nil {
				w.Header().Set("Content-Type", "application/json")
				status := fault.Status(e)
				if fault.Code(e) == "internal_error" {
					status = 500
				}
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": fault.Code(e)})
			}
			return
		}
		if path != "/v1/operations/session" && path != "/v1/operations/logout" && path != "/v1/account/session" && path != "/v1/account/logout" {
			next.ServeHTTP(w, r)
			return
		}
		id := uuid.NewString()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Request-ID", id)
		var value any
		var e error
		if path == "/v1/account/session" && r.Method == "GET" {
			value, e = g.accountSession(r)
		} else if path == "/v1/account/logout" && r.Method == "POST" {
			if r.URL.RawQuery != "" {
				e = fault.New("not_found", 404)
			} else {
				e = emptySessionBody(r)
			}
			if e == nil {
				value, e = g.accountLogout(w, r)
			}
		} else if r.URL.RawQuery != "" {
			e = fault.New("invalid_operations_query", 400)
		} else if path == "/v1/operations/session" && r.Method == "GET" {
			value, e = g.operatorSession(r)
		} else if path == "/v1/operations/logout" && r.Method == "POST" {
			value, e = g.operatorLogout(w, r)
		} else {
			e = fault.New("not_found", 404)
		}
		status := 200
		if e != nil {
			status = fault.Status(e)
			if fault.Code(e) == "internal_error" {
				status = 500
			}
			value = map[string]any{"error": fault.Code(e), "requestId": id}
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(value)
	})
}

func emptySessionBody(r *http.Request) error {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return fault.New("unsupported_media_type", 415)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return e
	}
	if len(b) > 32768 {
		return fault.New("request_too_large", 413)
	}
	var value map[string]json.RawMessage
	if !utf8.Valid(b) || json.Unmarshal(b, &value) != nil || value == nil || len(value) != 0 {
		return fault.New("invalid_request", 400)
	}
	return nil
}
func (g *Gateway) operatorSession(r *http.Request) (any, error) {
	_, authorization, e := g.Operator(r, false, "workbench.read")
	if fault.Code(e) == "operations_login_required" {
		return map[string]any{"state": "signed-out"}, nil
	}
	if e != nil {
		return nil, e
	}
	b := authorization.(*bound)
	return postgres.InTx(r.Context(), g.Pool, func(tx pgx.Tx) (any, error) {
		row, e := g.row(r.Context(), tx, "operator", b.hash)
		if errors.Is(e, pgx.ErrNoRows) {
			return map[string]any{"state": "signed-out"}, nil
		}
		if e != nil {
			return nil, e
		}
		if row.ID != b.id || row.ID != identity.Digest([]byte(row.Issuer+"\x00"+row.Subject)) {
			return nil, fault.New("operations_access_denied", 403)
		}
		authority, e := g.effective(r.Context(), tx, row)
		if e != nil {
			return nil, e
		}
		var name string
		var expires int64
		e = tx.QueryRow(r.Context(), `SELECT display_name,CASE WHEN refresh_cipher IS NOT NULL AND refresh_cipher<>'' THEN LEAST(idle_expires_at,max_expires_at)
		 ELSE floor(extract(epoch FROM expires_at))::bigint END FROM operations_operator_sessions_v1
		 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3 FOR SHARE`, g.Config.Endpoint, g.Config.OperatorConfiguration, b.hash).Scan(&name, &expires)
		if e != nil {
			return nil, e
		}
		names, e := g.Directory.Roles(r.Context(), row.Issuer, row.Subject)
		if e != nil {
			return nil, fault.New("operations_unavailable", 503)
		}
		admission := "reader"
		if contains(names, g.Config.AdministratorRole) {
			admission = "administrator"
		}
		return map[string]any{"state": "signed-in", "operator": map[string]any{"id": row.ID, "displayName": name, "role": authority.Role, "admission": admission, "rootAdministrator": authority.Root, "businessAuthorization": authority}, "csrfToken": row.CSRF, "expiresAt": expires}, nil
	})
}
func (g *Gateway) operatorLogout(w http.ResponseWriter, r *http.Request) (any, error) {
	if !g.origin(r, "operator", true) {
		return nil, fault.New("operations_csrf_invalid", 403)
	}
	if _, ok := r.Header["Authorization"]; ok {
		return nil, fault.New("operations_access_denied", 403)
	}
	if e := emptySessionBody(r); e != nil {
		return nil, e
	}
	token := cookie(r, g.cookie("operator"))
	if token == "" {
		return nil, fault.New("operations_access_denied", 403)
	}
	hash := identity.Digest([]byte(token))
	var csrf string
	e := g.Pool.QueryRow(r.Context(), `SELECT csrf_token FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3 AND expires_at>$4`, g.Config.Endpoint, g.Config.OperatorConfiguration, hash, time.Unix(g.now(), 0)).Scan(&csrf)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fault.New("operations_access_denied", 403)
	}
	if e != nil {
		return nil, e
	}
	if !equal(header(r, "X-Galaxy-Operator-CSRF"), csrf) {
		return nil, fault.New("operations_access_denied", 403)
	}
	loginName := "__Host-galaxy-operator-login"
	secure := strings.HasPrefix(g.Config.AdminOrigin, "https:")
	if !secure {
		loginName = "galaxy-operator-login-fixture"
	}
	login := cookie(r, loginName)
	_, e = postgres.InTx(r.Context(), g.Pool, func(tx pgx.Tx) (bool, error) {
		if _, e := tx.Exec(r.Context(), "DELETE FROM operations_operator_sessions_v1 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3", g.Config.Endpoint, g.Config.OperatorConfiguration, hash); e != nil {
			return false, e
		}
		if login != "" {
			_, e := tx.Exec(r.Context(), "UPDATE operations_operator_logins_v1 SET status='revoked' WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3", g.Config.Endpoint, g.Config.OperatorConfiguration, identity.Digest([]byte(login)))
			if e != nil {
				return false, e
			}
		}
		return true, nil
	})
	if e != nil {
		return nil, e
	}
	for _, name := range []string{g.cookie("operator"), loginName} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	}
	return map[string]any{"state": "signed-out"}, nil
}
