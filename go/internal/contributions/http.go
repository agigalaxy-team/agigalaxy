package contributions

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func route(path string) bool {
	switch path {
	case "/v2/contributions/status", "/v2/contributions/sources", "/v2/contributions/preview", "/v2/contributions/publish", "/v2/contributions/read":
		return true
	}
	return false
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !route(r.URL.Path) {
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
	out, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, id string) (any, error) {
	if r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("contribution_unavailable", 503)
	}
	var actor *Actor
	auth := r.Header.Get("Authorization")
	if len(r.Header.Values("Authorization")) > 0 {
		if !strings.HasPrefix(auth, "Bearer ") {
			return nil, fail("access_denied", 401)
		}
		a, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "history")
		if e != nil {
			return nil, e
		}
		actor = &Actor{Actor: a, HTTPRequestID: &id}
	} else if r.URL.Path != "/v2/contributions/read" {
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
		return nil, fail("invalid_json", 400)
	}
	if r.URL.Path == "/v2/contributions/publish" {
		var input Envelope
		if protocol.Decode(raw, &input) != nil {
			return nil, fail("invalid_request", 400)
		}
		return s.Submit(r.Context(), *actor, input)
	}
	value, e := jstext.DecodeJSON(raw)
	if e != nil || object(value) == nil {
		return nil, fail("invalid_request", 400)
	}
	input := object(value)
	switch r.URL.Path {
	case "/v2/contributions/status":
		return s.Status(r.Context(), *actor, input)
	case "/v2/contributions/sources":
		return s.OwnedSources(r.Context(), *actor, input)
	case "/v2/contributions/preview":
		return s.Preview(r.Context(), *actor, input)
	default:
		return s.ReadProjection(r.Context(), actor, input)
	}
}
