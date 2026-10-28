package builders

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

var routes = map[string]string{"/v1/builders/read": "get", "/v1/builders/query": "query", "/v1/builders/manage/read": "manage", "/v1/builders/owned/query": "owned", "/v1/builders/notices/query": "notices", "/v1/builders/events": "publish", "/v1/builders/events/receipt": "receipt", "/v2/builders/pack/manifest": "manifest", "/v2/builders/support/read": "support", "/v2/builders/support/events": "extension-publish", "/v2/builders/pack/export": "export-pack", "/v2/builders/pack-uses/events": "use-submit", "/v2/builders/pack-uses/read": "use-read", "/v2/builders/pack-uses/query": "use-query", "/v2/builders/pack-uses/candidates": "use-candidates", "/v2/builders/pack-uses/receipt": "use-receipt"}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method, matched := routes[r.URL.Path]
	if !matched || r.Method != "POST" {
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
func (h Handler) dispatch(r *http.Request, method, id string) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("builder_service_unavailable", 503)
	}
	var a *deviceauth.Actor
	header := r.Header.Get("Authorization")
	_, supplied := r.Header[http.CanonicalHeaderKey("Authorization")]
	required := contains([]string{"publish", "receipt", "extension-publish", "use-submit", "use-candidates", "use-receipt", "manage", "owned"}, method)
	if supplied || required || method == "export-control" || method == "export-report" {
		if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
			return nil, fault.New("access_denied", 401)
		}
		actor, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "builders")
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
	var input Object
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, fault.New("invalid_request", 400)
	}
	if (method == "use-query" || method == "query") && h.ConsumeSearchPage != nil && input["after"] != nil {
		if e = h.ConsumeSearchPage(r, a, input["after"]); e != nil {
			return nil, e
		}
	}
	switch method {
	case "specification":
		if len(input) != 0 {
			return nil, fault.New("unknown_fields", 400)
		}
		return Specification(), nil
	case "export-control":
		return h.Service.ExportNodeControl(r.Context(), *a, raw, id)
	case "export-report":
		return h.Service.ExportReport(r.Context(), *a, raw, id)
	case "get":
		return h.Service.Get(r.Context(), a, raw)
	case "query":
		return h.Service.Query(r.Context(), a, raw, QueryOptions{})
	case "manage":
		return h.Service.Manage(r.Context(), *a, raw)
	case "owned":
		return h.Service.Owned(r.Context(), *a, raw)
	case "notices":
		return h.Service.Notices(r.Context(), a, raw)
	case "publish":
		return h.Service.Publish(r.Context(), *a, raw, id)
	case "receipt":
		return h.Service.Receipt(r.Context(), *a, raw)
	case "extension-publish":
		return h.Service.ExtensionPublish(r.Context(), *a, raw, id)
	case "support":
		return h.Service.Support(r.Context(), a, raw)
	case "manifest":
		return h.Service.Manifest(r.Context(), a, raw)
	case "export-pack":
		return h.Service.ExportPack(r.Context(), a, raw)
	case "use-submit":
		return h.Service.PackUseSubmit(r.Context(), *a, raw, id)
	case "use-read":
		return h.Service.PackUseRead(r.Context(), a, raw)
	case "use-query":
		return h.Service.PackUseQuery(r.Context(), a, raw)
	case "use-candidates":
		return h.Service.PackUseCandidates(r.Context(), *a, raw)
	case "use-receipt":
		return h.Service.PackUseReceipt(r.Context(), *a, raw)
	}
	return nil, fault.New("not_found", 404)
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("builderReceiptSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		row, e := one(ctx, tx, "SELECT builder_id::text,subject_id,consent_id::text,payload_hash,revision FROM builder_events WHERE id=$1", input["eventId"])
		if e != nil {
			return nil, e
		}
		if row != nil && row["subject_id"] != a.SubjectID {
			return nil, fault.New("builder_unavailable", 404)
		}
		state := "absent"
		if row != nil {
			state = "conflict"
			if row["builder_id"] == input["builderId"] && row["payload_hash"] == input["payloadHash"] {
				state = "acknowledged"
			}
		}
		out := Object{"builderId": input["builderId"], "eventId": input["eventId"], "payloadHash": input["payloadHash"], "checkedAt": s.now(), "state": state, "authority": "accepted-event-only; no current disclosure or capability conclusion"}
		if state == "acknowledged" {
			out["consentId"] = row["consent_id"]
			out["revision"] = row["revision"]
		}
		return out, nil
	})
}
