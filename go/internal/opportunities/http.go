package opportunities

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
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

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || !has([]string{"/v2/discovery/query", "/v2/discovery/detail", "/v1/discovery/query", "/v1/discovery/preferences/read", "/v1/discovery/preferences/save"}, r.URL.Path) {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", id)
	out, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, requestID string) (Object, error) {
	s := h.Service
	if s == nil || s.Pool == nil || s.Devices == nil {
		return nil, fail("discovery_unavailable", 503)
	}
	var a *deviceauth.Actor
	legacy := strings.HasPrefix(r.URL.Path, "/v1/")
	scope := "history"
	if strings.Contains(r.URL.Path, "/preferences/") {
		scope = "notifications"
	}
	if header := r.Header.Get("Authorization"); header != "" {
		if !strings.HasPrefix(header, "Bearer ") {
			return nil, fail("access_denied", 401)
		}
		v, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), scope)
		if e != nil {
			return nil, e
		}
		a = &v
	}
	if legacy && a == nil {
		return nil, fail("access_denied", 401)
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
		return nil, fail("invalid_json", 409)
	}
	var input Object
	if protocol.Decode(raw, &input) != nil || input == nil {
		return nil, fail("invalid_request", 409)
	}
	if legacy {
		switch r.URL.Path {
		case "/v1/discovery/preferences/read":
			if len(input) != 0 {
				return nil, fail("invalid_request", 409)
			}
			return s.Preferences(r.Context(), *a, &requestID)
		case "/v1/discovery/preferences/save":
			return s.SavePreferences(r.Context(), *a, input, &requestID)
		default:
			return s.QueryLegacy(r.Context(), a, input)
		}
	}
	if strings.HasSuffix(r.URL.Path, "/detail") {
		return s.Detail(r.Context(), a, input)
	}
	return s.Query(r.Context(), a, input)
}
