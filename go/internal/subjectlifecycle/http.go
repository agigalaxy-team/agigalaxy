package subjectlifecycle

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

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	known := contains([]string{"/v1/data-exports/specification", "/v1/data-exports/create", "/v1/data-exports/page", "/v1/data-exports/binary", "/v1/data-exports/revoke", "/v1/deletion-requests/config", "/v1/deletion-requests/submit", "/v1/deletion-requests/read", "/v1/deletion-requests/query", "/v1/deletion-requests/status"}, r.URL.Path)
	if !known {
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
func strictBody(raw []byte, out any, allowed ...string) error {
	var fields map[string]json.RawMessage
	if protocol.Decode(raw, out) != nil || json.Unmarshal(raw, &fields) != nil || fields == nil {
		return fault.New("invalid_request", 400)
	}
	var tree any
	_ = json.Unmarshal(raw, &tree)
	if containsNull(tree) {
		return fault.New("invalid_request", 400)
	}
	for k, v := range fields {
		if !contains(allowed, k) || string(v) == "null" {
			return fault.New("invalid_request", 400)
		}
	}
	return nil
}
func (h Handler) dispatch(r *http.Request, id string) (any, error) {
	if r.Method != "POST" {
		return nil, fault.New("not_found", 404)
	}
	s := h.Service
	if s == nil || s.Devices == nil || s.Pool == nil {
		return nil, fault.New("subject_lifecycle_unavailable", 503)
	}
	status := r.URL.Path == "/v1/deletion-requests/status"
	scope := "data-export"
	if strings.HasPrefix(r.URL.Path, "/v1/deletion-requests/") {
		scope = "data-delete"
	}
	a := Actor{HTTPRequestID: &id}
	if !status {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") || strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")) != strings.TrimPrefix(header, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		actor, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), scope)
		if e != nil {
			return nil, e
		}
		a.Actor = actor
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil || !utf8.Valid(raw) {
		return nil, fault.New("invalid_request", 400)
	}
	if len(raw) > 32768 {
		return nil, fault.New("request_too_large", 413)
	}
	if !json.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, fault.New("invalid_request", 400)
	}
	switch r.URL.Path {
	case "/v1/data-exports/specification", "/v1/deletion-requests/config":
		var empty struct{}
		if e = strictBody(raw, &empty); e != nil {
			return nil, e
		}
		if scope == "data-export" {
			return s.Specification(r.Context(), a)
		}
		return s.DeletionConfig(r.Context(), a)
	case "/v1/data-exports/create":
		var input CreateInput
		if strictBody(raw, &input, "id", "datasets", "views") != nil {
			return nil, invalidExport()
		}
		return s.Create(r.Context(), a, input)
	case "/v1/data-exports/page":
		input := PageInput{Limit: 50}
		if strictBody(raw, &input, "id", "dataset", "after", "limit") != nil || input.Limit == 0 {
			return nil, invalidExport()
		}
		return s.Page(r.Context(), a, input)
	case "/v1/data-exports/binary":
		input := BinaryInput{Length: 524288}
		if strictBody(raw, &input, "id", "dataset", "recordId", "offset", "length") != nil || input.Length == 0 {
			return nil, invalidExport()
		}
		return s.Binary(r.Context(), a, input)
	case "/v1/data-exports/revoke":
		var input struct {
			ID string `json:"id"`
		}
		if strictBody(raw, &input, "id") != nil {
			return nil, invalidExport()
		}
		return s.Revoke(r.Context(), a, input.ID)
	case "/v1/deletion-requests/submit", "/v1/deletion-requests/status":
		var input struct {
			Signed string `json:"signed"`
		}
		if strictBody(raw, &input, "signed") != nil {
			return nil, invalidDeletion()
		}
		if status {
			return s.DeletionStatus(r.Context(), input.Signed)
		}
		return s.SubmitDeletion(r.Context(), a, input.Signed)
	case "/v1/deletion-requests/read":
		var input struct {
			ID    string `json:"id"`
			After int64  `json:"afterRevision"`
		}
		if strictBody(raw, &input, "id", "afterRevision") != nil {
			return nil, invalidDeletion()
		}
		return s.ReadDeletion(r.Context(), a, input.ID, input.After)
	case "/v1/deletion-requests/query":
		input := struct {
			After string `json:"after"`
			Limit int    `json:"limit"`
		}{Limit: 10}
		if strictBody(raw, &input, "after", "limit") != nil || input.Limit == 0 {
			return nil, invalidDeletion()
		}
		return s.QueryDeletions(r.Context(), a, input.After, input.Limit)
	}
	return nil, fault.New("not_found", 404)
}

func containsNull(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case map[string]any:
		for _, item := range v {
			if containsNull(item) {
				return true
			}
		}
	case []any:
		for _, item := range v {
			if containsNull(item) {
				return true
			}
		}
	}
	return false
}
