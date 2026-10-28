package experiencereviews

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v2/experience/submit" && r.URL.Path != "/v2/experience/read" {
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
		return nil, fail("experience_unavailable", 503)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	a, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "assistance")
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
	actor := Actor{Actor: a, HTTPRequestID: &id}
	if strings.HasSuffix(r.URL.Path, "/submit") {
		var input Envelope
		if protocol.Decode(raw, &input) != nil {
			return nil, fail("invalid_request", 400)
		}
		return s.Submit(r.Context(), actor, input)
	}
	var input Object
	if protocol.Decode(raw, &input) != nil || input == nil {
		return nil, fail("invalid_request", 400)
	}
	return s.Read(r.Context(), actor, input)
}
