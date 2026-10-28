package information

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
	Watches           *Watches
	Devices           DeviceIdentity
	ConsumeSearchPage func(*http.Request, *deviceauth.Actor, any) error
	Next              http.Handler
}

var watchPath = regexp.MustCompile(`^/v2/information/watches/(command|stop|list|receipt|check|events)$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := watchPath.FindStringSubmatch(r.URL.Path)
	if r.Method != "POST" || r.URL.Path != "/v2/information/query" && path == nil {
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
	action := "query"
	if path != nil {
		action = path[1]
	}
	out, e := h.dispatch(r, path != nil, action, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, watch bool, action, requestID string) (Object, error) {
	if watch && h.Watches == nil || !watch && h.Service == nil {
		return nil, fault.New("information_unavailable", 503)
	}
	scope := "binding"
	if watch {
		scope = "notifications"
	}
	var a *deviceauth.Actor
	_, supplied := r.Header[http.CanonicalHeaderKey("Authorization")]
	if watch || supplied {
		header := r.Header.Get("Authorization")
		if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		actor, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), scope)
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
	var o Object
	if json.Unmarshal(raw, &o) != nil || o == nil {
		return nil, fault.New("invalid_request", 400)
	}
	if !watch {
		input, e := ParseQuery(raw)
		if e != nil {
			return nil, e
		}
		if h.ConsumeSearchPage != nil {
			for _, selected := range list(input["sources"]) {
				request := obj(obj(obj(selected)["source"])["request"])
				after, present := obj(request["query"])["after"]
				if after == nil {
					after, present = request["after"]
				}
				if present {
					if e = h.ConsumeSearchPage(r, a, after); e != nil {
						return nil, e
					}
				}
			}
		}
		return h.Service.Query(r.Context(), a, encode(input))
	}
	if action == "list" && h.ConsumeSearchPage != nil {
		if after, present := o["after"]; present {
			if e = h.ConsumeSearchPage(r, a, after); e != nil {
				return nil, e
			}
		}
	}
	switch action {
	case "command":
		return h.Watches.Command(r.Context(), *a, raw, requestID)
	case "stop":
		return h.Watches.Stop(r.Context(), *a, raw, requestID)
	case "list":
		return h.Watches.List(r.Context(), *a, raw)
	case "receipt":
		return h.Watches.Receipt(r.Context(), *a, raw)
	case "check":
		return h.Watches.Check(r.Context(), *a, raw)
	default:
		return h.Watches.Events(r.Context(), *a, raw)
	}
}
