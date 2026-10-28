package targetgovernance

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/google/uuid"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

var routeID = regexp.MustCompile(`^[0-9a-f-]{36}$`)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/v2/target-governance/")
	get := r.Method == "GET" && (path == "config" || routeID.MatchString(path))
	post := r.Method == "POST" && has([]string{"target", "reports", "events", "query", "receipt"}, path)
	if !strings.HasPrefix(r.URL.Path, "/v2/target-governance/") || !get && !post {
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
	out, e := h.dispatch(r, id, path, get)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, id, path string, get bool) (Object, error) {
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("target_governance_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	device, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "moderation")
	if e != nil {
		return nil, e
	}
	a := Actor{Device: &device, RequestID: id}
	if get {
		if path == "config" {
			return s.Config(r.Context(), a)
		}
		return s.Read(r.Context(), a, path)
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
		return nil, fail("invalid_json", 409)
	}
	var input Object
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, fail("invalid_request", 409)
	}
	switch path {
	case "reports", "events":
		if len(input) != 2 || !strict(input, "consentId", "payloadJson") {
			return nil, fail("invalid_request", 409)
		}
		if path == "reports" {
			return s.Report(r.Context(), a, raw)
		}
		return s.Event(r.Context(), a, raw)
	case "target":
		return s.TargetInfo(r.Context(), a, raw)
	case "receipt":
		return s.Receipt(r.Context(), a, raw)
	case "query":
		var after *string
		if _, ok := input["after"]; ok {
			v := str(input, "after")
			after = &v
		}
		if e = httpboundary.ConsumeSearchPage(r.Context(), after, "subject", device.SubjectID); e != nil {
			return nil, e
		}
		return s.Query(r.Context(), a, raw)
	}
	return nil, invalid()
}
