package discovery

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type LegacyDeviceIdentity interface {
	Authenticate(context.Context, string, string) (deviceauth.Actor, error)
}
type LegacyHandler struct {
	Service           *LegacySearch
	Devices           LegacyDeviceIdentity
	ConsumeSearchPage func(*http.Request, *deviceauth.Actor, any) error
	Next              http.Handler
}

func (h LegacyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || r.URL.EscapedPath() != "/v1/search/query" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-ID")
	if !validID(id) {
		id = uuid.NewString()
		w.Header().Set("X-Request-ID", id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	wire, e := h.dispatch(r)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": id})
		return
	}
	_, _ = w.Write(wire)
}
func (h LegacyHandler) dispatch(r *http.Request) (json.RawMessage, error) {
	if h.Service == nil {
		return nil, fail("search_source_unavailable")
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
	var input Object
	if decode(raw, &input) != nil || input == nil {
		return nil, fault.New("invalid_request", 400)
	}
	kind, q, e := parseLegacySearch(raw)
	if e != nil {
		return nil, e
	}
	var viewer *deviceauth.Actor
	if _, present := r.Header[http.CanonicalHeaderKey("Authorization")]; present {
		header := r.Header.Get("Authorization")
		if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		scope := "history"
		switch kind {
		case "proof":
			scope = "proof"
		case "capsule":
			scope = "capsules"
		case "worker", "hub":
			scope = "builders"
		}
		a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), scope)
		if e != nil {
			return nil, e
		}
		viewer = &a
	}
	if after, present := q["after"]; present && h.ConsumeSearchPage != nil {
		if e = h.ConsumeSearchPage(r, viewer, after); e != nil {
			return nil, e
		}
	}
	return h.Service.QueryWire(r.Context(), viewer, []byte(jsonString(Object{"type": kind, "query": q})))
}
