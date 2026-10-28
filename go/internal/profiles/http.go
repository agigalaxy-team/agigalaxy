package profiles

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type DeviceIdentity interface {
	Authenticate(context.Context, string, string) (deviceauth.Actor, error)
}
type HistoryQuery func(context.Context, *deviceauth.Actor, []byte) (Object, error)
type Handler struct {
	Service      *Service
	Devices      DeviceIdentity
	HistoryQuery HistoryQuery
	Next         http.Handler
}

var publicPath = regexp.MustCompile(`^/v1/profiles/(GUID[0-9A-Z]{28})$`)

func profileBody(r *http.Request, keys []string) ([]byte, error) {
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
	if json.Unmarshal(raw, &o) != nil || o == nil || len(o) != len(keys) {
		return nil, fault.New("invalid_request", 400)
	}
	for _, k := range keys {
		if _, ok := o[k]; !ok {
			return nil, fault.New("invalid_request", 400)
		}
	}
	return raw, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path != "/v1/profiles/statements" && path != "/v1/profiles/statements/receipt" && path != "/v1/profiles/current" && publicPath.FindStringSubmatch(path) == nil {
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
	out, e := h.dispatch(r, requestID)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": requestID})
		return
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, requestID string) (Object, error) {
	if match := publicPath.FindStringSubmatch(r.URL.Path); match != nil {
		if r.Method != "GET" {
			return nil, fault.New("not_found", 404)
		}
		if h.HistoryQuery == nil {
			return nil, fault.New("profile_reader_unavailable", 503)
		}
		var viewer *deviceauth.Actor
		if _, present := r.Header["Authorization"]; present {
			header := r.Header.Get("Authorization")
			if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
				return nil, fault.New("access_denied", 401)
			}
			a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "history")
			if e != nil {
				return nil, e
			}
			viewer = &a
		}
		return h.HistoryQuery(r.Context(), viewer, encode(Object{"subjectId": match[1]}))
	}
	if r.Method != "POST" || h.Service == nil || h.Service.Pool == nil {
		return nil, fault.New("not_found", 404)
	}
	current := r.URL.Path == "/v1/profiles/current"
	var raw []byte
	var e error
	if current {
		if _, e = profileBody(r, []string{}); e != nil {
			return nil, e
		}
	}
	header := r.Header.Get("Authorization")
	if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
		return nil, fault.New("access_denied", 401)
	}
	a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "history")
	if e != nil {
		return nil, e
	}
	if current {
		return h.Service.OwnerCurrent(r.Context(), a)
	}
	if r.URL.Path == "/v1/profiles/statements/receipt" {
		raw, e = profileBody(r, []string{"operationId", "payloadHash"})
		if e != nil {
			return nil, e
		}
		return h.Service.Receipt(r.Context(), a, raw)
	}
	raw, e = profileBody(r, []string{"consentId", "payloadJson"})
	if e != nil {
		return nil, e
	}
	return h.Service.Publish(r.Context(), a, raw, requestID)
}
