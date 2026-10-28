package watchcontrol

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

var route = regexp.MustCompile(`^/v2/watch-controls/(register|takeover|stop|query|read|receipt)$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	match := route.FindStringSubmatch(r.URL.Path)
	if match == nil || r.Method != "POST" {
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
	out, e := h.dispatch(r, match[1])
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, kind string) (Object, error) {
	if h.Service == nil || h.Devices == nil {
		return nil, fault.New("watch_control_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, fault.New("access_denied", 401)
	}
	a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "binding")
	if e != nil {
		return nil, e
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
	var p Object
	if json.Unmarshal(raw, &p) != nil || p == nil {
		return nil, fault.New("invalid_request", 400)
	}
	if kind == "query" && h.ConsumeSearchPage != nil {
		if after, present := p["after"]; present {
			if e = h.ConsumeSearchPage(r, &a, after); e != nil {
				return nil, e
			}
		}
	}
	ctx := r.Context()
	switch kind {
	case "register":
		return h.Service.Register(ctx, a, raw)
	case "takeover":
		return h.Service.Takeover(ctx, a, raw)
	case "stop":
		return h.Service.Stop(ctx, a, raw)
	case "query":
		return h.Service.Query(ctx, a, raw)
	case "read":
		return h.Service.Get(ctx, a, raw)
	case "receipt":
		return h.Service.Receipt(ctx, a, raw)
	}
	return nil, fault.New("not_found", 404)
}
