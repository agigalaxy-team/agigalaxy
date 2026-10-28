package qualification

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

func calculationRoute(path string) bool {
	return path == "/v2/qualification/calculation-permissions" || path == "/v2/qualification/calculation-receipt" || path == "/v2/qualification/calculation-owned"
}
func requestRoute(path string) bool {
	switch path {
	case "/v2/qualification/permission-requests/plan", "/v2/qualification/permission-requests/events", "/v2/qualification/permission-requests/read", "/v2/qualification/permission-requests/query", "/v2/qualification/permission-requests/receipt":
		return true
	}
	return false
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/qualification/policies" && r.URL.Path != "/v1/qualification/evaluate" && r.URL.Path != "/v2/qualification/evaluate" && r.URL.Path != "/v2/qualification/candidates" && !calculationRoute(r.URL.Path) && !requestRoute(r.URL.Path) {
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
func requestBody(r *http.Request) ([]byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	maximum := 32768
	raw, e := io.ReadAll(io.LimitReader(r.Body, int64(maximum+1)))
	if e != nil {
		return nil, e
	}
	if len(raw) > maximum {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 400)
	}
	return raw, nil
}
func (h Handler) dispatch(r *http.Request, id string) (any, error) {
	if r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("qualification_unavailable", 503)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	a, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "assistance")
	if e != nil {
		return nil, e
	}
	raw, e := requestBody(r)
	if e != nil {
		return nil, e
	}
	actor := Actor{Actor: a, HTTPRequestID: &id}
	if requestRoute(r.URL.Path) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			var input Envelope
			if protocol.Decode(raw, &input) != nil {
				return nil, fail("invalid_request", 400)
			}
			return s.SubmitRequest(r.Context(), actor, input)
		}
		var input Object
		if protocol.Decode(raw, &input) != nil || input == nil {
			return nil, fail("invalid_request", 400)
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/plan"):
			return s.PlanRequest(r.Context(), actor, input)
		case strings.HasSuffix(r.URL.Path, "/read"):
			return s.ReadRequest(r.Context(), actor, input)
		case strings.HasSuffix(r.URL.Path, "/query"):
			return s.QueryRequests(r.Context(), actor, input)
		default:
			return s.RequestReceipt(r.Context(), actor, input)
		}
	}
	if r.URL.Path == "/v2/qualification/candidates" {
		var input Object
		if protocol.Decode(raw, &input) != nil || input == nil {
			return nil, fail("invalid_request", 400)
		}
		return s.Candidates(r.Context(), actor, input)
	}
	if calculationRoute(r.URL.Path) {
		if r.URL.Path == "/v2/qualification/calculation-permissions" {
			var input Envelope
			if protocol.Decode(raw, &input) != nil {
				return nil, fail("invalid_request", 400)
			}
			return s.SubmitCalculation(r.Context(), actor, input)
		}
		var input Object
		if protocol.Decode(raw, &input) != nil || input == nil {
			return nil, fail("invalid_request", 400)
		}
		if r.URL.Path == "/v2/qualification/calculation-receipt" {
			return s.CalculationReceipt(r.Context(), actor, input)
		}
		return s.OwnedCalculations(r.Context(), actor, input)
	}
	if strings.HasSuffix(r.URL.Path, "/policies") {
		var v Object
		if json.Unmarshal(raw, &v) != nil || v == nil || len(v) != 0 {
			return nil, fail("invalid_request", 400)
		}
		return s.List(r.Context(), actor)
	}
	if r.URL.Path == "/v2/qualification/evaluate" {
		return s.EvaluateV2(r.Context(), actor, raw)
	}
	return s.Evaluate(r.Context(), actor, raw)
}
