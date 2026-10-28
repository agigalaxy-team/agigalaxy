package chat

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/google/uuid"
	"net/http"
	"strconv"
	"strings"
)

type ContactHandler struct {
	Service *ContactService
	Next    http.Handler
}

func (h ContactHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/v2/contacts/")
	read := r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v2/contacts/") && validID(path)
	if !read && !(r.Method == "POST" && (r.URL.Path == "/v2/contacts" || r.URL.Path == "/v2/contacts/query")) {
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
	out, e := h.dispatch(r, id, path, read)
	if e != nil {
		out = Object{"error": fault.Code(e), "requestId": id}
		if details := publicwrites.Details(e); details != nil {
			if details["quota"] != nil {
				out["quota"] = details["quota"]
			}
			if fault.Code(e) == "community_restricted" {
				out["restrictionReason"] = details["restrictionReason"]
			}
			if retry, ok := details["retryAfterSeconds"].(int64); ok && retry > 0 {
				w.Header().Set("Retry-After", strconv.FormatInt(retry, 10))
			}
		}
		w.WriteHeader(fault.Status(e))
	}
	json.NewEncoder(w).Encode(out)
}
func (h ContactHandler) dispatch(r *http.Request, id, path string, read bool) (Object, error) {
	f := h.Service
	if f == nil || f.Chat == nil || f.Chat.Devices == nil {
		return nil, fail("contact_service_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	actor, e := f.Chat.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "history")
	if e != nil {
		return nil, e
	}
	a := Actor{Device: &actor, RequestID: id}
	if read {
		return f.Get(r.Context(), a, path)
	}
	raw, input, e := readChatBody(r)
	if e != nil {
		return nil, e
	}
	if r.URL.Path == "/v2/contacts/query" {
		return f.Query(r.Context(), a, raw)
	}
	if len(input) != 2 || !strict(input, "consentId", "payloadJson") {
		return nil, fail("invalid_request")
	}
	return f.Submit(r.Context(), a, raw)
}
