package contextdata

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

var v1Path = regexp.MustCompile(`^/v1/context-grants/([0-9a-f-]{36})(?:/(accept|revoke))?$`)
var v2Path = regexp.MustCompile(`^/v2/context/([0-9a-f-]{36})(?:/(metadata|events))?$`)

func route(r *http.Request) (version int, action, id string) {
	path := r.URL.Path
	if r.Method == "POST" {
		switch path {
		case "/v1/context-grants":
			return 1, "create", ""
		case "/v1/context-grants/query":
			return 1, "query", ""
		case "/v1/context-grants/receipt":
			return 1, "receipt", ""
		case "/v2/context/grants":
			return 2, "create", ""
		case "/v2/context/query":
			return 2, "query", ""
		case "/v2/context/receipt":
			return 2, "receipt", ""
		}
	}
	if m := v1Path.FindStringSubmatch(path); m != nil {
		if r.Method == "GET" && m[2] == "" {
			return 1, "get", m[1]
		}
		if r.Method == "POST" && m[2] != "" {
			return 1, m[2], m[1]
		}
	}
	if m := v2Path.FindStringSubmatch(path); m != nil {
		if r.Method == "GET" && m[2] != "events" {
			action := "get"
			if m[2] == "metadata" {
				action = "metadata"
			}
			return 2, action, m[1]
		}
		if r.Method == "POST" && m[2] == "events" {
			return 2, "event", m[1]
		}
	}
	return 0, "", ""
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	version, action, id := route(r)
	if version == 0 {
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
	out, e := h.dispatch(r, version, action, id, requestID)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": requestID}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, version int, action, id, requestID string) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("context_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
		return nil, fault.New("access_denied", 401)
	}
	a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "context")
	if e != nil {
		return nil, e
	}
	if r.Method == "GET" {
		if version == 1 {
			return h.Service.GetV1(r.Context(), a, id, requestID)
		}
		return h.Service.GetV2(r.Context(), a, id, action == "metadata", requestID)
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
	input, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	if (action == "create" || action == "accept" || action == "event") && !exact(input, []string{"consentId", "payloadJson"}, nil) || version == 1 && action == "query" && !exact(input, []string{"assistanceId"}, nil) || version == 1 && action == "revoke" && !exact(input, nil, nil) {
		return nil, fault.New("invalid_request", 400)
	}
	if version == 2 {
		switch action {
		case "query":
			if h.ConsumeSearchPage != nil {
				if after, present := input["after"]; present {
					if e = h.ConsumeSearchPage(r, &a, after); e != nil {
						return nil, e
					}
				}
			}
			return h.Service.QueryV2(r.Context(), a, raw, requestID)
		case "create":
			return h.Service.CreateV2(r.Context(), a, raw, requestID)
		case "event":
			return h.Service.SubmitEventV2(r.Context(), a, id, raw, requestID)
		default:
			return h.Service.ReceiptV2(r.Context(), a, raw)
		}
	}
	switch action {
	case "query":
		return h.Service.QueryV1(r.Context(), a, raw, requestID)
	case "create":
		return h.Service.CreateV1(r.Context(), a, raw, requestID)
	case "accept":
		return h.Service.AcceptV1(r.Context(), a, id, raw, requestID)
	case "revoke":
		return h.Service.RevokeV1(r.Context(), a, id, requestID)
	default:
		return h.Service.ReceiptV1(r.Context(), a, raw)
	}
}
