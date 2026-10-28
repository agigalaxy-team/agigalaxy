package personalaudit

import (
	"encoding/json"
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

var routes = map[string]string{"/v1/audit/config": "config", "/v1/audit/query": "query", "/v1/audit/export": "export", "/v1/audit/grants": "grants", "/v1/audit/grants/approve": "approve", "/v1/audit/grants/revoke": "revoke"}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method, ok := routes[r.URL.Path]
	if !ok || r.Method != "POST" {
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
	out, e := h.dispatch(r, method, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, method, id string) (any, error) {
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("audit_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	scope := "audit"
	if method == "approve" || method == "revoke" {
		scope = "audit-review"
	}
	current, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), scope)
	if e != nil {
		return nil, e
	}
	a := Actor{Device: current, HTTPRequestID: &id}
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
	switch method {
	case "config", "grants":
		if len(input) > 0 {
			return nil, fail("invalid_request", 409)
		}
		if method == "config" {
			return s.Config(r.Context(), a)
		}
		return s.ListGrants(r.Context(), a)
	case "approve":
		if !strict(input, "signed") || len(input) != 1 {
			return nil, fail("invalid_request", 409)
		}
		signed, ok := input["signed"].(string)
		if !ok {
			return nil, fail("invalid_audit_approval", 409)
		}
		return s.Approve(r.Context(), a, signed)
	case "revoke":
		return s.Revoke(r.Context(), a, input)
	default:
		return s.Query(r.Context(), a, input, method)
	}
}
