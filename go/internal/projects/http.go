package projects

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
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

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v2/projects/"), "/")
	read := r.Method == "GET" && len(parts) == 1 && uuidPattern.MatchString(parts[0])
	preference := r.Method == "POST" && len(parts) == 3 && uuidPattern.MatchString(parts[0]) && parts[1] == "preferences" && contains([]string{"read", "save"}, parts[2])
	collection := r.Method == "POST" && contains([]string{"/v2/projects/directory/query", "/v2/projects/portfolio/query"}, r.URL.Path)
	matched := strings.HasPrefix(r.URL.Path, "/v2/projects/") && (read || preference || collection || r.Method == "POST" && r.URL.Path == "/v2/projects/query") || r.Method == "POST" && r.URL.Path == "/v2/projects"
	if !matched {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	requestID := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", requestID)
	out, e := h.dispatch(r, requestID, parts, read, preference, collection)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": requestID}
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, requestID string, parts []string, read, preference, collection bool) (Object, error) {
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("project_service_unavailable", 503)
	}
	a := Actor{RequestID: requestID}
	header := r.Header.Get("Authorization")
	if header != "" {
		if !strings.HasPrefix(header, "Bearer ") {
			return nil, fail("access_denied", 401)
		}
		device, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "history")
		if e != nil {
			return nil, e
		}
		a.Device = &device
	} else if !read && !collection {
		return nil, fail("access_denied", 401)
	}
	if read {
		return s.Get(r.Context(), a, parts[0])
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
	var input Object
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 409)
	}
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, fail("invalid_request", 409)
	}
	if collection {
		var after *string
		if _, ok := input["after"]; ok {
			value := str(input, "after")
			after = &value
		}
		kind, id := "anonymous", ""
		if a.Device != nil {
			kind, id = "subject", a.Device.SubjectID
		}
		if e = httpboundary.ConsumeSearchPage(r.Context(), after, kind, id); e != nil {
			return nil, e
		}
		if r.URL.Path == "/v2/projects/portfolio/query" {
			return s.PublicPortfolio(r.Context(), a, raw)
		}
		return s.PublicDirectory(r.Context(), a, raw)
	}
	if preference {
		if parts[2] == "read" {
			if len(input) != 0 {
				return nil, fail("invalid_request", 409)
			}
			return s.Preferences(r.Context(), a, parts[0])
		}
		return s.SavePreferences(r.Context(), a, parts[0], raw)
	}
	if r.URL.Path == "/v2/projects/query" {
		return s.List(r.Context(), a, raw)
	}
	if len(input) != 2 || !strict(input, "consentId", "payloadJson") {
		return nil, fail("invalid_request", 409)
	}
	return s.Submit(r.Context(), a, raw)
}
