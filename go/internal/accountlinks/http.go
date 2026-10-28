package accountlinks

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type Handler struct {
	Links *Links
	Next  http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	prefix := "/v1/identity/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	operation := strings.TrimPrefix(r.URL.Path, prefix)
	requestID := uuid.NewString()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Request-ID", requestID)
	fail := func(e error) {
		status := fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": requestID})
	}
	if h.Links == nil {
		fail(fault.New("identity_unavailable", 503))
		return
	}
	if r.Method == "GET" && strings.HasPrefix(operation, "callback/") {
		provider := strings.TrimPrefix(operation, "callback/")
		if !providerID.MatchString(provider) {
			fail(fault.New("not_found", 404))
			return
		}
		result, e := h.Links.Callback(r.Context(), provider, h.Links.Registry.Endpoint+r.URL.RequestURI())
		if e != nil {
			fail(e)
			return
		}
		json.NewEncoder(w).Encode(result)
		return
	}
	if r.Method != "POST" || r.URL.RawQuery != "" || (operation != "providers" && operation != "begin" && operation != "status" && operation != "cancel" && operation != "confirm" && operation != "query" && operation != "revoke") {
		fail(fault.New("not_found", 404))
		return
	}
	headers := r.Header.Values("Authorization")
	if len(headers) != 1 || !strings.HasPrefix(headers[0], "Bearer ") {
		fail(fault.New("access_denied", 401))
		return
	}
	actor, e := h.Links.Registry.Devices.Authenticate(r.Context(), strings.TrimPrefix(headers[0], "Bearer "), "binding")
	if e != nil {
		fail(e)
		return
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		fail(fault.New("unsupported_media_type", 415))
		return
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		fail(e)
		return
	}
	if len(raw) > 32768 {
		fail(fault.New("request_too_large", 413))
		return
	}
	var fields map[string]json.RawMessage
	if !utf8.Valid(raw) || decode(raw, &fields) != nil || fields == nil {
		fail(fault.New("invalid_json", 400))
		return
	}
	var result Object
	switch operation {
	case "providers":
		if len(fields) != 0 {
			fail(fault.New("invalid_request", 400))
			return
		}
		result, e = h.Links.Providers(r.Context(), actor)
	case "begin":
		result, e = h.Links.Begin(r.Context(), actor, raw)
	case "query":
		result, e = h.Links.Query(r.Context(), actor, raw)
	default:
		var input struct {
			ID     string `json:"id"`
			Signed string `json:"signed,omitempty"`
		}
		if decode(raw, &input) != nil || !validUUID(input.ID) || operation != "confirm" && (len(fields) != 1 || fields["id"] == nil) || operation == "confirm" && (len(fields) != 2 || fields["id"] == nil || fields["signed"] == nil) {
			fail(fault.New("invalid_request", 400))
			return
		}
		switch operation {
		case "status":
			result, e = h.Links.Status(r.Context(), actor, input.ID)
		case "cancel":
			result, e = h.Links.Cancel(r.Context(), actor, input.ID)
		case "confirm":
			result, e = h.Links.Confirm(r.Context(), actor, input.ID, input.Signed, &requestID)
		case "revoke":
			result, e = h.Links.Revoke(r.Context(), actor, input.ID, &requestID)
		}
	}
	if e != nil {
		fail(e)
		return
	}
	json.NewEncoder(w).Encode(result)
}
