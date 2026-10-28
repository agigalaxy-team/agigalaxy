package notifications

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
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

var inboxRoute = regexp.MustCompile(`^/v2/notifications/(query|options/(?:read|save)|presentation/(?:claim|ack)|read)$`)
var legacyRoutes = map[string]string{"/v1/notifications/query": "query", "/v1/notifications/preferences/read": "preferences/read", "/v1/notifications/preferences/save": "preferences/save", "/v1/notifications/read": "read", "/v1/notifications/archive": "archive"}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	match := inboxRoute.FindStringSubmatch(r.URL.Path)
	legacy := legacyRoutes[r.URL.Path]
	if match == nil && legacy == "" {
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
	out, e := h.dispatch(r, id, match, legacy)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, id string, match []string, legacy string) (any, error) {
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("notification_service_unavailable", 503)
	}
	if r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	current, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "notifications")
	if e != nil {
		return nil, e
	}
	actor := Actor{Actor: current, HTTPRequestID: &id}
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
	var input Object
	if protocol.Decode(raw, &input) != nil || input == nil {
		return nil, fail("invalid_request", 400)
	}
	if legacy != "" {
		switch legacy {
		case "query":
			return s.LegacyQuery(r.Context(), actor, input)
		case "preferences/read":
			if len(input) != 0 {
				return nil, fail("invalid_request", 400)
			}
			return s.Preferences(r.Context(), actor)
		case "preferences/save":
			return s.SavePreferences(r.Context(), actor, input)
		case "archive":
			return s.Archive(r.Context(), actor, input)
		case "read":
			if !shape(input, []string{"id"}, nil) {
				return nil, fail("invalid_request", 400)
			}
			return s.LegacyMarkRead(r.Context(), actor, str(input, "id"))
		}
	}
	switch match[1] {
	case "query":
		return s.Query(r.Context(), actor, input)
	case "options/read":
		if len(input) != 0 {
			return nil, fail("invalid_request", 400)
		}
		return s.Options(r.Context(), actor)
	case "options/save":
		return s.SaveOptions(r.Context(), actor, input)
	case "presentation/claim":
		return s.Claim(r.Context(), actor, input)
	case "presentation/ack":
		return s.Presented(r.Context(), actor, input)
	case "read":
		return s.MarkRead(r.Context(), actor, input)
	}
	return nil, fail("not_found", 404)
}
