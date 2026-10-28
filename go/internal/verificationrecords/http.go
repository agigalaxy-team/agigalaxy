package verificationrecords

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

type DeviceIdentity interface {
	Authenticate(context.Context, string, string) (deviceauth.Actor, error)
}
type Handler struct {
	Service *Service
	Devices DeviceIdentity
	Next    http.Handler
}

func body(r *http.Request) ([]byte, error) {
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
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	var o Object
	if json.Unmarshal(raw, &o) != nil || o == nil {
		return nil, fault.New("invalid_request", 400)
	}
	return raw, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	matched := r.Method == "POST" && one(path, "/v2/verification-records/submit", "/v2/verification-records/read", "/v2/verification-records/status", "/v2/verification-records/receipt")
	if !matched {
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
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, id string) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("verification_records_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
		return nil, fault.New("access_denied", 401)
	}
	a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "evidence")
	if e != nil {
		return nil, e
	}
	raw, e := body(r)
	if e != nil {
		return nil, e
	}
	switch r.URL.Path {
	case "/v2/verification-records/submit":
		return h.Service.Submit(r.Context(), a, raw, id)
	case "/v2/verification-records/read":
		return h.Service.Get(r.Context(), a, raw)
	case "/v2/verification-records/status":
		return h.Service.Status(r.Context(), a, raw)
	default:
		return h.Service.Receipt(r.Context(), a, raw)
	}
}
