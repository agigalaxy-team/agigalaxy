package civ2

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
	Service *Service
	Devices DeviceIdentity
	Next    http.Handler
}

var statusPath = regexp.MustCompile(`^/v2/ci/proofs/([0-9a-f-]{36})/status$`)

func body(r *http.Request, keys []string) ([]byte, error) {
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
	var o Object
	if json.Unmarshal(raw, &o) != nil || o == nil || keys != nil && !exact(o, keys) {
		return nil, fault.New("invalid_request", 400)
	}
	return raw, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	matched := r.Method == "POST" && one(path, "/v2/ci/receipts", "/v2/ci/requests", "/v2/ci/requests/read", "/v2/ci/requests/revoke", "/v2/ci/proofs/preview", "/v2/ci/proofs/publish", "/v2/ci/proofs/read", "/v2/ci/proofs/revoke") || r.Method == "GET" && statusPath.MatchString(path)
	if !matched {
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
	out, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) authenticate(r *http.Request, scope string, optional bool) (*deviceauth.Actor, error) {
	headers, present := r.Header["Authorization"]
	if !present && optional {
		return nil, nil
	}
	if h.Devices == nil || len(headers) == 0 || !strings.HasPrefix(headers[0], "Bearer ") {
		return nil, fault.New("access_denied", 401)
	}
	a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(headers[0], "Bearer "), scope)
	return &a, e
}
func (h Handler) dispatch(r *http.Request, requestID string) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("ci_service_unavailable", 503)
	}
	path := r.URL.Path
	var raw []byte
	var e error
	scope := "evidence"
	if path == "/v2/ci/receipts" {
		raw, e = body(r, []string{"id", "type"})
		if e != nil {
			return nil, e
		}
		var q Object
		_ = json.Unmarshal(raw, &q)
		if q["type"] != "request" {
			scope = "proof"
		}
	} else if strings.HasPrefix(path, "/v2/ci/proofs/") {
		scope = "proof"
	}
	status := statusPath.FindStringSubmatch(path)
	optional := path == "/v2/ci/proofs/read" || status != nil
	a, e := h.authenticate(r, scope, optional)
	if e != nil {
		return nil, e
	}
	if status != nil {
		raw = encode(Object{"id": status[1]})
	} else if raw == nil {
		var keys []string
		if path == "/v2/ci/requests" || path == "/v2/ci/proofs/publish" {
			keys = []string{"consentId", "payloadJson"}
		}
		raw, e = body(r, keys)
		if e != nil {
			return nil, e
		}
	}
	if optional {
		return h.Service.GetProof(r.Context(), a, raw)
	}
	switch path {
	case "/v2/ci/receipts":
		return h.Service.Receipt(r.Context(), *a, raw)
	case "/v2/ci/requests":
		return h.Service.Submit(r.Context(), *a, raw, requestID)
	case "/v2/ci/requests/read":
		return h.Service.Get(r.Context(), *a, raw)
	case "/v2/ci/requests/revoke":
		return h.Service.RevokeRequest(r.Context(), *a, raw, requestID)
	case "/v2/ci/proofs/preview":
		return h.Service.Preview(r.Context(), *a, raw)
	case "/v2/ci/proofs/publish":
		return h.Service.Publish(r.Context(), *a, raw, requestID)
	default:
		return h.Service.RevokeProof(r.Context(), *a, raw, requestID)
	}
}
