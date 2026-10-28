package identitygroups

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"regexp"
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

var groupPath = regexp.MustCompile(`^/v2/identity-groups/([0-9a-f-]{36})$`)
var operationPath = regexp.MustCompile(`^/v2/identity-groups/operations/([0-9a-f-]{36})$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method := ""
	id := ""
	if r.Method == "GET" {
		if m := groupPath.FindStringSubmatch(r.URL.Path); m != nil {
			method = "read"
			id = m[1]
		} else if m := operationPath.FindStringSubmatch(r.URL.Path); m != nil {
			method = "proposal"
			id = m[1]
		} else if r.URL.Path == "/v2/identity-groups/current" {
			method = "current"
		}
	} else if r.Method == "POST" {
		method = map[string]string{"/v2/identity-groups/submit": "submit", "/v2/identity-groups/query": "query", "/v2/identity-groups/resolve": "resolve", "/v2/identity-groups/receipt": "receipt", "/v2/identity-groups/source": "source"}[r.URL.Path]
	}
	if method == "" {
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
	out, e := h.dispatch(r, method, id, requestID)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": requestID}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, method, id, requestID string) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("identity_group_unavailable", 503)
	}
	optional := method == "read" || method == "query" || method == "resolve"
	header := r.Header.Get("Authorization")
	_, supplied := r.Header[http.CanonicalHeaderKey("Authorization")]
	var a *deviceauth.Actor
	if supplied || !optional {
		if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		actor, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "binding")
		if e != nil {
			return nil, e
		}
		a = &actor
	}
	if r.Method == "GET" {
		switch method {
		case "current":
			return h.Service.Current(r.Context(), *a)
		case "read":
			return h.Service.Read(r.Context(), a, id)
		case "proposal":
			return h.Service.Proposal(r.Context(), *a, id)
		}
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
	if method == "submit" && (len(input) != 3 || input["payloadJson"] == nil || input["proofJson"] == nil || input["signature"] == nil) {
		return nil, fault.New("invalid_request", 400)
	}
	if method == "query" && h.ConsumeSearchPage != nil {
		cursor := input["after"]
		if _, exists := input["after"]; !exists {
			cursor = input["proposalAfter"]
		}
		if cursor != nil {
			if e = h.ConsumeSearchPage(r, a, cursor); e != nil {
				return nil, e
			}
		}
	}
	switch method {
	case "submit":
		return h.Service.Submit(r.Context(), *a, raw, requestID)
	case "query":
		return h.Service.Query(r.Context(), a, raw)
	case "resolve":
		return h.Service.Resolve(r.Context(), a, raw)
	case "receipt":
		return h.Service.Receipt(r.Context(), *a, raw)
	case "source":
		return h.Service.Source(r.Context(), *a, raw)
	}
	return nil, fault.New("not_found", 404)
}
