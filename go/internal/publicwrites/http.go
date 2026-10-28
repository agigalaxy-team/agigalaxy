package publicwrites

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v2/account/quotas" {
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
	w.Header().Set("X-Content-Type-Options", "nosniff")
	out, e := h.dispatch(r)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
		for k, v := range Details(e) {
			out[k] = v
		}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request) (Object, error) {
	if r.Method != "POST" {
		return nil, fault.New("not_found", 404)
	}
	s := h.Service
	if s == nil || s.Links == nil || s.Links.Devices == nil {
		return nil, fault.New("public_write_verification_unavailable", 503)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fault.New("access_denied", 401)
	}
	actor, e := s.Links.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "binding")
	if e != nil {
		return nil, e
	}
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
	var input Object
	if json.Unmarshal(raw, &input) != nil {
		return nil, fault.New("invalid_json", 400)
	}
	if input == nil || len(input) != 0 {
		return nil, fault.New("invalid_request", 400)
	}
	return s.Status(r.Context(), Actor{Device: &actor, Scope: "binding"})
}
