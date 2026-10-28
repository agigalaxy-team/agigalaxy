package trustpackages

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func trustRoute(path string) string {
	switch path {
	case "/v2/trust-package/permissions/preview":
		return "preview"
	case "/v2/trust-package/permissions/submit":
		return "submit"
	case "/v2/trust-package/permissions/revoke-preview":
		return "revoke-preview"
	case "/v2/trust-package/permissions/receipt":
		return "receipt"
	case "/v2/trust-package/permissions/status":
		return "status"
	case "/v2/trust-package/permissions/query":
		return "query"
	case "/v2/trust-package/sources":
		return "sources"
	}
	return ""
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	action := trustRoute(r.URL.Path)
	if action == "" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", id)
	v, e := h.dispatch(r, action, &id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		v = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(v)
}
func (h Handler) dispatch(r *http.Request, action string, id *string) (Object, error) {
	if r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("trust_unavailable", 503)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	a, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "consent")
	if e != nil {
		return nil, e
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return nil, e
	}
	if len(raw) > 32768 {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 400)
	}
	var q Object
	if json.Unmarshal(raw, &q) != nil || q == nil {
		return nil, fail("invalid_request", 400)
	}
	actor := Actor{Actor: a, HTTPRequestID: id}
	switch action {
	case "preview":
		return s.Preview(r.Context(), actor, q)
	case "revoke-preview":
		return s.RevokePreview(r.Context(), actor, q)
	case "submit":
		return s.Submit(r.Context(), actor, q)
	case "receipt":
		return s.Receipt(r.Context(), actor, q)
	case "status":
		return s.Status(r.Context(), actor, q)
	case "query":
		return s.Query(r.Context(), actor, q)
	default:
		return s.Sources(r.Context(), actor, q)
	}
}
