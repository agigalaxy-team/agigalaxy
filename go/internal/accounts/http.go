package accounts

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Authorization is bound to the verified online-account session, not a request
// supplied role or account header. Revalidate lifecycle/revocation in this tx.
type Authorization interface {
	Account(context.Context, pgx.Tx, string, string) error
}

// Identity must implement the original portal cookie, website Origin, expected
// X-Galaxy-Account-ID and write X-Galaxy-Account-CSRF semantics. These routes
// have no signed-device fallback. Missing identity configuration closes them.
type HTTPIdentity interface {
	Account(*http.Request, bool) (string, Authorization, error)
}
type HTTPIdentityFunc func(*http.Request, bool) (string, Authorization, error)

func (f HTTPIdentityFunc) Account(r *http.Request, write bool) (string, Authorization, error) {
	return f(r, write)
}

type PublicPosts func(context.Context, pgx.Tx, string) (any, error)
type Handler struct {
	Service               *Service
	Pool                  *pgxpool.Pool
	Identity              HTTPIdentity
	PublicPosts           PublicPosts
	Providers             []Provider
	CurrentProviders      func() []Provider
	PublicPostsPage       PublicPageConsumer
	PublicCredentialsPage PublicPageConsumer
	Next                  http.Handler
}

var publicUIDPath = regexp.MustCompile(`^/v1/account/public/by-uid/([A-Za-z0-9]{6,16})$`)
var publicIDPath = regexp.MustCompile(`^/v1/account/public/([0-9a-f-]{36})$`)

func accountBody(r *http.Request) ([]byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return nil, e
	}
	if len(raw) > 32768 {
		return nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil, fault.New("invalid_json", 400)
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, fault.New("invalid_request", 400)
	}
	return raw, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	uid, publicID := publicUIDPath.FindStringSubmatch(r.URL.Path), publicIDPath.FindStringSubmatch(r.URL.Path)
	bySubject, list := publicSubjectPath.FindStringSubmatch(r.URL.Path), publicListPath.FindStringSubmatch(r.URL.Path)
	if r.URL.Path != "/v1/account/settings" && r.URL.Path != "/v1/account/type-change" && uid == nil && publicID == nil && bySubject == nil && list == nil {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	public := uid != nil || publicID != nil || bySubject != nil || list != nil
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if public {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
	}
	requestID := uuid.NewString()
	w.Header().Set("X-Request-ID", requestID)
	var result Object
	var e error
	if bySubject != nil || list != nil {
		result, e = h.dispatchPublicPage(r, bySubject, list)
	} else {
		result, e = h.dispatchAccount(r, uid, publicID)
	}
	status := 200
	if e != nil {
		status = fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		result = Object{"error": fault.Code(e), "requestId": requestID}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}
func (h Handler) dispatchAccount(r *http.Request, uid, publicID []string) (Object, error) {
	public := uid != nil || publicID != nil
	if public && r.Method != "GET" || !public && r.URL.Path == "/v1/account/type-change" && r.Method != "POST" || !public && r.URL.Path == "/v1/account/settings" && r.Method != "GET" && r.Method != "POST" || !public && r.Method == "POST" && r.URL.RawQuery != "" {
		return nil, fault.New("not_found", 404)
	}
	if h.Service == nil || h.Pool == nil || h.Identity == nil {
		return nil, unavailable()
	}
	if public {
		if r.URL.RawQuery != "" {
			return nil, fault.New("invalid_account_query", 400)
		}
		posts := h.PublicPosts
		if posts == nil && h.PublicPostsPage != nil {
			posts = func(ctx context.Context, tx pgx.Tx, id string) (any, error) {
				return h.PublicPostsPage(ctx, tx, id, []byte("{}"))
			}
		}
		return postgres.InTx(r.Context(), h.Pool, func(tx pgx.Tx) (Object, error) {
			if uid != nil {
				return h.Service.PublicProfileByUIDWithin(r.Context(), tx, uid[1], posts)
			}
			return h.Service.PublicProfileWithin(r.Context(), tx, publicID[1], posts)
		})
	}
	if _, present := r.Header["Authorization"]; present {
		return nil, fault.New("access_denied", 401)
	}
	account, authority, e := h.Identity.Account(r, r.Method == "POST")
	if e != nil {
		return nil, e
	}
	if !uuidPattern.MatchString(account) {
		return nil, fault.New("official_account_login_required", 401)
	}
	if authority == nil {
		return nil, unavailable()
	}
	var raw []byte
	if r.Method == "POST" {
		raw, e = accountBody(r)
		if e != nil {
			return nil, e
		}
	}
	return postgres.InTx(r.Context(), h.Pool, func(tx pgx.Tx) (Object, error) {
		if e := authority.Account(r.Context(), tx, h.Service.Endpoint, account); e != nil {
			return nil, e
		}
		var result Object
		var e error
		if r.Method == "GET" {
			result, e = h.Service.SettingsWithin(r.Context(), tx, account)
		} else if strings.HasSuffix(r.URL.Path, "/settings") {
			result, e = h.Service.UpdateSettingsWithin(r.Context(), tx, account, raw)
		} else {
			result, e = h.Service.ChangeTypeWithin(r.Context(), tx, account, raw, TypeSource{Kind: "account-owner", AccountID: account}, nil)
		}
		if e != nil {
			return nil, e
		}
		if e = authority.Account(r.Context(), tx, h.Service.Endpoint, account); e != nil {
			return nil, e
		}
		return result, nil
	})
}
