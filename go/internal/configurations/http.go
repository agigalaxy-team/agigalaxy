package configurations

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

var routes = map[string]string{"/v2/configurations/events": "submit", "/v2/configurations/read": "read", "/v2/configurations/query": "query", "/v2/configurations/versions": "versions", "/v2/configurations/receipt": "receipt"}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method, matched := routes[r.URL.Path]
	if !matched || r.Method != "POST" {
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
	out, e := h.dispatch(r, method, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, method, id string) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("configuration_unavailable", 503)
	}
	var a *deviceauth.Actor
	header := r.Header.Get("Authorization")
	_, supplied := r.Header[http.CanonicalHeaderKey("Authorization")]
	if supplied || method == "submit" || method == "receipt" {
		if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		actor, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "history")
		if e != nil {
			return nil, e
		}
		a = &actor
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
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, fault.New("invalid_request", 400)
	}
	if method == "submit" && !exact(input, []string{"consentId", "payloadJson"}, nil) {
		return nil, fault.New("invalid_request", 400)
	}
	if (method == "query" || method == "versions") && h.ConsumeSearchPage != nil {
		value, present := input["after"]
		if value == nil {
			value, present = input["afterVersion"]
		}
		if present {
			if e = h.ConsumeSearchPage(r, a, value); e != nil {
				return nil, e
			}
		}
	}
	switch method {
	case "submit":
		return h.Service.Submit(r.Context(), *a, raw, id)
	case "read":
		return h.Service.Get(r.Context(), a, raw)
	case "query":
		return h.Service.Query(r.Context(), a, raw)
	case "versions":
		return h.Service.Versions(r.Context(), a, raw)
	default:
		return h.Service.Receipt(r.Context(), *a, raw)
	}
}
