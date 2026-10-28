package hubs

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
	Peering           *Peering
	Devices           DeviceIdentity
	ConsumeSearchPage func(*http.Request, *deviceauth.Actor, any) error
	Next              http.Handler
}

var routes = map[string]string{"/v2/hubs/status": "status", "/v2/hubs/events": "submit", "/v2/hubs/read": "read", "/v2/hubs/manage": "manage", "/v2/hubs/query": "query", "/v2/hubs/memberships": "members", "/v2/hubs/intake": "intake", "/v2/hubs/receipt": "receipt"}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method, ok := routes[r.URL.Path]
	if !ok || r.Method != "POST" {
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
		return nil, fault.New("hub_service_unavailable", 503)
	}
	var a *deviceauth.Actor
	header := r.Header.Get("Authorization")
	_, supplied := r.Header[http.CanonicalHeaderKey("Authorization")]
	optional := has([]any{"status", "read", "query"}, method)
	optional = optional || method == "peer-exchange"
	if method != "peer-exchange" && (supplied || !optional) {
		if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		actor, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "builders")
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
	if (method == "submit" || method == "peer-submit") && (len(input) != 2 || input["consentId"] == nil || input["payloadJson"] == nil) {
		return nil, fault.New("invalid_request", 400)
	}
	if method == "peer-exchange" && (len(input) != 1 || input["signed"] == nil) {
		return nil, fault.New("invalid_request", 400)
	}
	if strings.HasPrefix(method, "peer-") {
		if h.Peering == nil {
			return nil, fault.New("peering_unavailable", 503)
		}
		if method == "peer-exchange" {
			return h.Peering.Exchange(r.Context(), input)
		}
		if (method == "peer-query" || method == "peer-list") && h.ConsumeSearchPage != nil && input["after"] != nil {
			if e = h.ConsumeSearchPage(r, a, input["after"]); e != nil {
				return nil, e
			}
		}
		switch method {
		case "peer-submit":
			return h.Peering.Submit(r.Context(), *a, input, id)
		case "peer-read":
			return h.Peering.Read(r.Context(), *a, raw)
		case "peer-query":
			return h.Peering.Query(r.Context(), *a, raw)
		case "peer-list":
			return h.Peering.List(r.Context(), *a, raw)
		case "peer-preview":
			return h.Peering.Preview(r.Context(), *a, raw)
		case "peer-receipt":
			return h.Peering.Receipt(r.Context(), *a, raw)
		case "peer-sources":
			return h.Peering.Sources(r.Context(), *a, raw)
		case "peer-connections":
			return h.Peering.Connections(r.Context(), *a, raw)
		case "peer-party":
			return h.Peering.Party(r.Context(), *a, raw)
		}
	}
	if has([]any{"query", "members", "intake"}, method) && h.ConsumeSearchPage != nil && input["after"] != nil {
		if e = h.ConsumeSearchPage(r, a, input["after"]); e != nil {
			return nil, e
		}
	}
	switch method {
	case "status":
		return Specification(), nil
	case "submit":
		return h.Service.Submit(r.Context(), *a, input, id)
	case "read":
		return h.Service.Get(r.Context(), a, raw)
	case "manage":
		return h.Service.Manage(r.Context(), *a, raw)
	case "query":
		return h.Service.Query(r.Context(), a, raw)
	case "members":
		return h.Service.Members(r.Context(), *a, raw)
	case "intake":
		return h.Service.Intake(r.Context(), *a, raw)
	case "receipt":
		return h.Service.Receipt(r.Context(), *a, raw)
	}
	return nil, fault.New("not_found", 404)
}
