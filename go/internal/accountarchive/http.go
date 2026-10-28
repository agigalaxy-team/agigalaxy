package accountarchive

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
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
	Service  *Service
	Devices  DeviceIdentity
	Identity accounts.HTTPIdentity
	Next     http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	native := strings.HasPrefix(path, "/v2/account-work/")
	website := strings.HasPrefix(path, "/v1/account/work/")
	archives := strings.HasPrefix(path, "/v2/account-archives/")
	portalArchives := path == "/v1/account/archives" || strings.HasPrefix(path, "/v1/account/archives/")
	if !native && !website && !archives && !portalArchives {
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
	var result Object
	var e error
	if portalArchives {
		result, e = h.dispatchPortalArchives(r, request)
	} else {
		result, e = h.dispatch(r, native, website, archives, request)
	}
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": request})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}
func (h Handler) dispatch(r *http.Request, native, website, archives bool, request string) (Object, error) {
	prefix := "/v2/account-work/"
	if website {
		prefix = "/v1/account/work/"
	}
	if archives {
		prefix = "/v2/account-archives/"
	}
	action := strings.TrimPrefix(r.URL.Path, prefix)
	allowed := map[string]bool{"put": true, "get": true, "list": true, "delete": true, "status": true}
	if archives {
		allowed = map[string]bool{"accounts": true, "create": true, "chunk": true, "complete": true, "list": true, "status": true, "export": true, "delete": true, "cleanup": true}
	}
	if r.Method != "POST" || r.URL.RawQuery != "" || !allowed[action] || website && action == "put" {
		return nil, fault.New("not_found", 404)
	}
	if h.Service == nil {
		code := "account_work_unavailable"
		if archives {
			code = "official_account_unavailable"
		}
		return nil, fault.New(code, 503)
	}
	a := Actor{RequestID: request}
	if website {
		if _, present := r.Header["Authorization"]; present {
			return nil, fault.New("access_denied", 401)
		}
		if h.Identity == nil {
			return nil, fault.New("official_account_unavailable", 503)
		}
		id, authorization, e := h.Identity.Account(r, action == "delete")
		if e != nil {
			return nil, e
		}
		if authorization == nil {
			return nil, fault.New("official_account_unavailable", 503)
		}
		a.AccountID = id
		a.Official = true
		a.Endpoint = h.Service.Endpoint
		a.AuthorizeAccount = authorization.Account
	} else {
		auth := r.Header.Get("Authorization")
		if h.Devices == nil || !strings.HasPrefix(auth, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		verified, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "binding")
		if e != nil {
			return nil, e
		}
		a.Device = verified
		if action != "accounts" {
			a.AccountID = r.Header.Get("X-Galaxy-Account-ID")
			if !validID(a.AccountID) {
				return nil, fault.New("account_selection_required", 409)
			}
		}
	}
	max := int64(32768)
	if native && action == "put" {
		max = 1048576
	}
	if archives && action == "chunk" {
		max = 1572864
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
	var object Object
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, fault.New("invalid_request", 400)
	}
	if archives {
		if action == "accounts" {
			if len(object) != 0 {
				return nil, fault.New("invalid_request", 400)
			}
			return h.Service.Accounts(r.Context(), a, raw)
		}
		if action == "cleanup" && len(object) != 0 {
			return nil, fault.New("invalid_request", 400)
		}
		return h.Service.Archive(r.Context(), a, action, raw)
	}
	return h.Service.Work(r.Context(), a, action, raw)
}
