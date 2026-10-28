package accountsocial

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type DeviceIdentity interface {
	Authenticate(context.Context, string, string) (deviceauth.Actor, error)
}
type Handler struct {
	Service           *Service
	Identity          accounts.HTTPIdentity
	Devices           DeviceIdentity
	ConsumeSearchPage func(*http.Request, Actor, any) error
	Next              http.Handler
}

var socialPath = regexp.MustCompile(`^/(v1/account/follows|v1/account/bookmarks|v2/account-bookmarks|v2/reading-bookmarks)/(status|command|query|receipt)$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	match := socialPath.FindStringSubmatch(r.URL.Path)
	if match == nil {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	request := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", request)
	out, e := h.dispatch(r, match[1], match[2], request)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": request})
		return
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, family, method, request string) (Object, error) {
	follow := family == "v1/account/follows"
	portal := strings.HasPrefix(family, "v1/")
	account := family != "v2/reading-bookmarks"
	if follow && (h.Service == nil || h.Identity == nil) {
		return nil, fault.New("account_follow_unavailable", 503)
	}
	if r.Method != "POST" || follow && r.URL.RawQuery != "" || h.Service == nil {
		return nil, fault.New("not_found", 404)
	}
	a := Actor{RequestID: request}
	if portal {
		if h.Identity == nil {
			return nil, fault.New("access_denied", 401)
		}
		if _, present := r.Header["Authorization"]; present {
			return nil, fault.New("access_denied", 401)
		}
		id, authority, e := h.Identity.Account(r, method == "command")
		if e != nil {
			return nil, e
		}
		if authority == nil {
			return nil, fault.New("official_account_unavailable", 503)
		}
		a.AccountID = id
		a.Authority = authority
		a.Official = true
		a.Endpoint = h.Service.Endpoint
	} else {
		auth := r.Header.Get("Authorization")
		if h.Devices == nil || !strings.HasPrefix(auth, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		device, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "binding")
		if e != nil {
			return nil, e
		}
		a.Device = device
		if account {
			if values, ok := r.Header["X-Galaxy-Account-Id"]; ok {
				if len(values) != 1 || !validID(values[0]) {
					return nil, fault.New("invalid_account_target", 400)
				}
				a.AccountID = values[0]
			}
		}
	}
	max := int64(32768)
	if follow {
		max = 2048
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil {
		return nil, e
	}
	if int64(len(raw)) > max {
		return nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	var p Object
	if json.Unmarshal(raw, &p) != nil || p == nil {
		return nil, fault.New("invalid_request", 400)
	}
	if method == "query" && h.ConsumeSearchPage != nil {
		if after, present := p["after"]; present {
			if e = h.ConsumeSearchPage(r, a, after); e != nil {
				return nil, e
			}
		}
	}
	if follow {
		return h.Service.Follow(r.Context(), a, method, raw)
	}
	return h.Service.Bookmark(r.Context(), a, account, method, raw)
}
