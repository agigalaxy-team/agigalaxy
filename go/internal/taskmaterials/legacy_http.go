package taskmaterials

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/google/uuid"
)

type LegacyHandler struct {
	Service *Service
	Next    http.Handler
}

var legacyReadPath = regexp.MustCompile(`^/v1/assistance/([0-9a-f-]{36})$`)
var legacyEventPath = regexp.MustCompile(`^/v1/assistance/([0-9a-f-]{36})/events$`)

func legacyRoute(path string) bool {
	return path == "/v1/assistance" || path == "/v1/assistance/query" || path == "/v1/assistance/events/receipt" || path == "/v1/requester-history/query" || path == "/v1/requester-history/facts" || legacyReadPath.MatchString(path) || legacyEventPath.MatchString(path)
}
func (h LegacyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !legacyRoute(r.URL.Path) {
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
		for key, value := range publicwrites.Details(e) {
			out.(map[string]any)[key] = value
		}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h LegacyHandler) dispatch(r *http.Request, id string) (any, error) {
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("assistance_service_unavailable", 503)
	}
	read := legacyReadPath.FindStringSubmatch(r.URL.Path)
	if read != nil && r.Method != "GET" || read == nil && r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	current, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "assistance")
	if e != nil {
		return nil, e
	}
	actor := Actor{Actor: current, HTTPRequestID: &id}
	if read != nil {
		return s.LegacyGet(r.Context(), actor, read[1])
	}
	raw, e := body(r, 32768)
	if e != nil {
		return nil, e
	}
	if r.URL.Path == "/v1/assistance/query" {
		input, e := parseObject(string(raw))
		if e != nil {
			return nil, e
		}
		return s.LegacyQuery(r.Context(), actor, input)
	}
	if strings.HasPrefix(r.URL.Path, "/v1/requester-history/") {
		input, e := parseObject(string(raw))
		if e != nil {
			return nil, e
		}
		if strings.HasSuffix(r.URL.Path, "/facts") {
			return s.RequesterHistoryFacts(r.Context(), actor, input)
		}
		return s.RequesterHistory(r.Context(), actor, input)
	}
	if r.URL.Path == "/v1/assistance/events/receipt" {
		input, e := parseObject(string(raw))
		if e != nil || !exactFields(input, []string{"assistanceId", "eventId", "payloadHash"}, nil) {
			return nil, fail("invalid_assistance_query", 400)
		}
		return s.LegacyReceipt(r.Context(), actor, str(input, "assistanceId"), str(input, "eventId"), str(input, "payloadHash"))
	}
	var input Envelope
	if decode(raw, &input) != nil {
		return nil, fail("invalid_request", 400)
	}
	if r.URL.Path == "/v1/assistance" {
		return s.CreateLegacy(r.Context(), actor, input)
	}
	return s.SubmitLegacy(r.Context(), actor, legacyEventPath.FindStringSubmatch(r.URL.Path)[1], input)
}
