package requesterhistory

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
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

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v2/requester-history/query" && r.URL.Path != "/v2/requester-history/facts" {
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
	w.Header().Set("X-Request-ID", id)
	v, e := h.dispatch(r)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		v = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(v)
}
func (h Handler) dispatch(r *http.Request) (Object, error) {
	if r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	s := h.Service
	if s == nil {
		return nil, fail("requester_history_unavailable", 503)
	}
	var actor *deviceauth.Actor
	if auth := r.Header.Get("Authorization"); len(r.Header.Values("Authorization")) > 0 {
		if !strings.HasPrefix(auth, "Bearer ") {
			return nil, fail("access_denied", 401)
		}
		if s.Devices == nil {
			return nil, fail("requester_history_authority_unavailable", 503)
		}
		a, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "assistance")
		if e != nil {
			return nil, e
		}
		actor = &a
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
	var q Object
	if !utf8.Valid(raw) || !json.Valid(raw) || json.Unmarshal(raw, &q) != nil || q == nil {
		return nil, fail("invalid_json", 400)
	}
	if strings.HasSuffix(r.URL.Path, "/facts") {
		return s.Facts(r.Context(), actor, q)
	}
	return s.Query(r.Context(), actor, q)
}
