package agentos

import (
	"encoding/json"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
)

// StatusHandler exposes the original runtime status while the durable
// conversation/action handlers are assembled separately.
type StatusHandler struct {
	Client    *Client
	Authority operationspermissions.Authority
	Next      http.Handler
}

func (h StatusHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/operations/agentos/status" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-Id")
	if id == "" {
		id = uuid.NewString()
		w.Header().Set("X-Request-Id", id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	result, err := h.status(r)
	if err != nil {
		w.WriteHeader(fault.Status(err))
		result = Object{"error": fault.Code(err), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(result)
}
func (h StatusHandler) status(r *http.Request) (Object, error) {
	if r.Method != "GET" || r.URL.RawQuery != "" {
		return nil, fail("not_found", 404)
	}
	if h.Authority == nil || h.Client == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	before, err := h.Authority.AuthorizeOperations(r, false, "workbench.read")
	if err != nil {
		return nil, err
	}
	result := h.Client.Status(r.Context())
	after, err := h.Authority.AuthorizeOperations(r, false, "workbench.read")
	if err != nil {
		return nil, err
	}
	if before.ID != after.ID || before.Endpoint != after.Endpoint {
		return nil, fail("business_admin_denied", 403)
	}
	at := h.Client.now().Unix()
	result["checkedAt"], result["readExpiresAt"] = at, at+30
	return result, nil
}
