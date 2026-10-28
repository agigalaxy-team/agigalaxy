package operationsqueries

import (
	"encoding/json"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
)

type WorkbenchHandler struct {
	Workbench *Workbench
	Authority operationspermissions.Authority
	Next      http.Handler
}

func (h WorkbenchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.EscapedPath() != "/v1/operations/summary" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-ID")
	if !validID(id) {
		id = uuid.NewString()
		w.Header().Set("X-Request-ID", id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	result, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		result = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(result)
}
func (h WorkbenchHandler) dispatch(r *http.Request, id string) (Object, error) {
	if r.Method != "GET" {
		return nil, fail("not_found", 404)
	}
	if h.Workbench == nil || h.Authority == nil {
		return nil, fail("business_admin_unavailable", 503)
	}
	a, e := h.Authority.AuthorizeOperations(r, false, "workbench.read")
	if e != nil {
		return nil, e
	}
	a.RequestID = &id
	options := Object{}
	for key, values := range r.URL.Query() {
		if key != "publicActivity" || len(values) != 1 || values[0] != "deferred" {
			return nil, fail("invalid_operations_request", 400)
		}
		options[key] = values[0]
	}
	return h.Workbench.Summary(r.Context(), a, options)
}
