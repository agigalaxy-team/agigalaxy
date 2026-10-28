package searchv2

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

type DeviceIdentity interface {
	Authenticate(context.Context, string, string) (deviceauth.Actor, error)
}
type Handler struct {
	Service           *Service
	Devices           DeviceIdentity
	ConsumeSearchPage func(*http.Request, *deviceauth.Actor, any) error
	Next              http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || r.URL.Path != "/v2/search/query" && r.URL.Path != "/v2/search/reference" {
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
	out, e := h.dispatch(r)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("search_source_unavailable", 503)
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return nil, e
	}
	if len(raw) > 32768 {
		return nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	var object Object
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, fault.New("invalid_request", 400)
	}
	reference := r.URL.Path == "/v2/search/reference"
	var parsed Object
	if reference {
		parsed, e = ParseReference(raw)
	} else {
		parsed, e = ParseQuery(raw)
	}
	if e != nil {
		return nil, e
	}
	query := parsed
	if reference {
		query = obj(parsed["search"])
	}
	var a *deviceauth.Actor
	if _, present := r.Header[http.CanonicalHeaderKey("Authorization")]; present {
		header := r.Header.Get("Authorization")
		if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		actor, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), Scope(text(query, "type")))
		if e != nil {
			return nil, e
		}
		a = &actor
	}
	if h.ConsumeSearchPage != nil {
		if after, present := obj(query["query"])["after"]; present {
			if e = h.ConsumeSearchPage(r, a, after); e != nil {
				return nil, e
			}
		}
	}
	if reference {
		return h.Service.Reference(r.Context(), a, encode(parsed))
	}
	return h.Service.Query(r.Context(), a, encode(parsed))
}
