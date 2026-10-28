package history

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
type Handler struct {
	Service           *Service
	QueryV2           func(context.Context, *deviceauth.Actor, []byte) (Object, error)
	Devices           DeviceIdentity
	ConsumeSearchPage func(*http.Request, *deviceauth.Actor, any) error
	Next              http.Handler
}

var profilePath = regexp.MustCompile(`^/v1/profiles/(GUID[0-9A-Z]{28})$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	profile := profilePath.FindStringSubmatch(r.URL.Path)
	matched := r.URL.Path == "/v1/history/query" || r.URL.Path == "/v2/history/query" || profile != nil
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
	w.Header().Set("X-Request-ID", id)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	out, e := h.dispatch(r, profile)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": id})
		return
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, profile []string) (Object, error) {
	if profile != nil && r.Method != "GET" || profile == nil && r.Method != "POST" {
		return nil, fault.New("not_found", 404)
	}
	if h.Service == nil {
		return nil, fault.New("history_unavailable", 503)
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
	raw := encode(Object{"subjectId": ""})
	if profile != nil {
		raw = encode(Object{"subjectId": profile[1]})
	} else {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			return nil, fault.New("unsupported_media_type", 415)
		}
		b, e := io.ReadAll(io.LimitReader(r.Body, 32769))
		if e != nil {
			return nil, e
		}
		if len(b) > 32768 {
			return nil, fault.New("request_too_large", 413)
		}
		if !utf8.Valid(b) || !json.Valid(b) {
			return nil, fault.New("invalid_json", 400)
		}
		var p Object
		if json.Unmarshal(b, &p) != nil || p == nil {
			return nil, fault.New("invalid_request", 400)
		}
		if after, ok := p["after"]; ok && h.ConsumeSearchPage != nil {
			if e = h.ConsumeSearchPage(r, viewer, after); e != nil {
				return nil, e
			}
		}
		raw = b
	}
	if r.URL.Path == "/v2/history/query" {
		if h.QueryV2 == nil {
			return nil, fault.New("history_v2_unavailable", 503)
		}
		return h.QueryV2(r.Context(), viewer, raw)
	}
	return h.Service.Query(r.Context(), viewer, raw)
}
