package capsules

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
	Devices           DeviceIdentity
	ConsumeSearchPage func(*http.Request, *deviceauth.Actor, any) error
	Next              http.Handler
}

var methods = map[string]string{"/v1/capsules/events": "publish", "/v1/capsules/uses": "use", "/v1/capsules/read": "read", "/v1/capsules/query": "query", "/v1/capsules/uses/query": "uses", "/v2/capsules/events": "publish-v2", "/v2/capsules/uses": "use-v2", "/v2/capsules/read": "read-v2", "/v2/capsules/query": "query-v2", "/v2/capsules/uses/query": "uses-v2", "/v2/capsules/preview": "preview", "/v2/capsules/permissions": "permission", "/v2/capsules/permissions/read": "permission-read", "/v2/capsules/receipt": "receipt", "/v2/capsules/versions": "versions", "/v2/capsules/permissions/query": "permissions"}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method, ok := methods[r.URL.Path]
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
func (h Handler) dispatch(r *http.Request, method, requestID string) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("capsule_unavailable", 503)
	}
	writing := method == "publish" || method == "publish-v2" || method == "use" || method == "use-v2" || method == "permission"
	private := method == "preview" || method == "permission-read" || method == "receipt" || method == "permissions"
	var actor *deviceauth.Actor
	_, supplied := r.Header[http.CanonicalHeaderKey("Authorization")]
	if writing || private || supplied {
		auth := r.Header.Get("Authorization")
		if h.Devices == nil || !strings.HasPrefix(auth, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "capsules")
		if e != nil {
			return nil, e
		}
		actor = &a
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
	if writing {
		if len(input) != 2 {
			return nil, fault.New("invalid_request", 400)
		}
		if _, ok := input["consentId"]; !ok {
			return nil, fault.New("invalid_request", 400)
		}
		if _, ok := input["payloadJson"]; !ok {
			return nil, fault.New("invalid_request", 400)
		}
	}
	if strings.HasSuffix(r.URL.Path, "/query") && h.ConsumeSearchPage != nil {
		if after, present := input["after"]; present {
			if e = h.ConsumeSearchPage(r, actor, after); e != nil {
				return nil, e
			}
		}
	}
	ctx := r.Context()
	switch method {
	case "publish":
		return h.Service.Publish(ctx, *actor, raw, requestID)
	case "publish-v2":
		return h.Service.PublishV2(ctx, *actor, raw, requestID)
	case "use":
		return h.Service.RecordUse(ctx, *actor, raw, requestID)
	case "use-v2":
		return h.Service.RecordUseV2(ctx, *actor, raw, requestID)
	case "permission":
		return h.Service.Permission(ctx, *actor, raw, requestID)
	case "read":
		return h.Service.Get(ctx, actor, raw)
	case "read-v2":
		return h.Service.GetV2(ctx, actor, raw)
	case "query":
		return h.Service.Query(ctx, actor, raw)
	case "query-v2":
		return h.Service.QueryV2(ctx, actor, raw)
	case "uses":
		return h.Service.Uses(ctx, actor, raw)
	case "uses-v2":
		return h.Service.UsesV2(ctx, actor, raw)
	case "preview":
		return h.Service.Preview(ctx, *actor, raw)
	case "permission-read":
		return h.Service.GetPermission(ctx, *actor, raw)
	case "receipt":
		return h.Service.Receipt(ctx, *actor, raw)
	case "versions":
		return h.Service.Versions(ctx, actor, raw)
	case "permissions":
		return h.Service.Permissions(ctx, *actor, raw)
	}
	return nil, fault.New("not_found", 404)
}
