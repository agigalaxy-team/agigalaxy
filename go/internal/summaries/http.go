package summaries

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
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

func summaryRoute(path string) string {
	prefix := "/v2/personal-summaries/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	action := strings.TrimPrefix(path, prefix)
	switch action {
	case "preferences/read", "preferences/save", "put", "get", "list", "delete", "receipt", "sources":
		return action
	}
	return ""
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	action := summaryRoute(r.URL.Path)
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
	v, e := h.dispatch(r, action)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		v = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(v)
}
func (h Handler) dispatch(r *http.Request, action string) (Object, error) {
	if r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("summary_unavailable", 503)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	a, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "binding")
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
	v, e := jstext.DecodeJSON(raw)
	if e != nil || object(v) == nil {
		return nil, fail("invalid_request", 400)
	}
	q := object(v)
	if action == "preferences/read" {
		if _, e = Parse(action, q); e != nil {
			return nil, e
		}
		return s.Preferences(r.Context(), a)
	}
	switch action {
	case "preferences/save":
		return s.SavePreference(r.Context(), a, q)
	case "get":
		return s.Get(r.Context(), a, q)
	case "list":
		return s.List(r.Context(), a, q)
	case "put":
		return s.Put(r.Context(), a, q)
	case "receipt":
		return s.Receipt(r.Context(), a, q)
	case "sources":
		return s.Sources(r.Context(), a, q)
	default:
		return s.Delete(r.Context(), a, q)
	}
}
