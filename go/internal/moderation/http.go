package moderation

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

var reportRoute = regexp.MustCompile(`^/v1/moderation/reports/([0-9a-f-]{36})/(read|events|receipt)$`)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	match := reportRoute.FindStringSubmatch(r.URL.Path)
	known := has([]string{"/v1/moderation/config", "/v1/moderation/reports", "/v1/moderation/reports/query"}, r.URL.Path)
	if r.Method != "POST" || match == nil && !known {
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
	out, e := h.dispatch(r, id, match)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, requestID string, match []string) (Object, error) {
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("moderation_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	a, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "moderation")
	if e != nil {
		return nil, e
	}
	actor := Actor{Device: &a, RequestID: requestID}
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
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, fail("invalid_request", 409)
	}
	if strings.HasSuffix(r.URL.Path, "/config") {
		if len(input) != 0 {
			return nil, fail("invalid_request", 409)
		}
		return s.Config(r.Context(), actor)
	}
	if strings.HasSuffix(r.URL.Path, "/query") {
		return s.Query(r.Context(), actor, raw)
	}
	if match != nil {
		switch match[2] {
		case "read":
			if len(input) != 0 {
				return nil, fail("invalid_request", 409)
			}
			return s.Get(r.Context(), actor, match[1])
		case "receipt":
			if len(input) != 2 || !strict(input, "eventId", "payloadHash") {
				return nil, fail("invalid_request", 409)
			}
			input["reportId"] = match[1]
			return s.Receipt(r.Context(), actor, encode(input))
		}
	}
	if len(input) != 2 || !strict(input, "consentId", "payloadJson") {
		return nil, fail("invalid_request", 409)
	}
	if match != nil {
		return s.Event(r.Context(), actor, match[1], raw)
	}
	return s.Report(r.Context(), actor, raw)
}
