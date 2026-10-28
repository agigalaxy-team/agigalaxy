package agentos

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"regexp"
)

type ExecutionHandler struct {
	Runtime   *ExecutionRuntime
	Authority operationspermissions.Authority
	Next      http.Handler
}

var executionHTTPPath = regexp.MustCompile(`(?i)^/v1/operations/agentos/executions/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:/(events|runs|review|continue))?$`)
var executionOperationPath = regexp.MustCompile(`(?i)^/v1/operations/agentos/operations/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)

func (h ExecutionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	execution, operation := executionHTTPPath.FindStringSubmatch(path), executionOperationPath.FindStringSubmatch(path)
	if path != "/v1/operations/agentos/options" && path != "/v1/operations/agentos/executions" && execution == nil && operation == nil {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-ID")
	if id == "" {
		id = uuid.NewString()
		w.Header().Set("X-Request-ID", id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	result, e := h.dispatch(r, id, execution, operation)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		result = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(result)
}
func (h ExecutionHandler) dispatch(r *http.Request, requestID string, execution, operation []string) (Object, error) {
	write := r.Method == "POST"
	validRead := r.Method == "GET" && (execution == nil || execution[2] == "")
	validWrite := write && (r.URL.Path == "/v1/operations/agentos/executions" || execution != nil && execution[2] != "")
	if !validRead && !validWrite || r.URL.RawQuery != "" {
		return nil, fail("not_found", 404)
	}
	if h.Runtime == nil || h.Runtime.Authority == nil || h.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	actor, e := h.Authority.AuthorizeOperations(r, write, "workbench.read")
	if e != nil {
		return nil, e
	}
	actor.RequestID = &requestID
	s := h.Runtime.Authority
	if write {
		limit := int64(32768)
		if execution != nil && (execution[2] == "runs" || execution[2] == "review") {
			limit = 65536
		}
		input, e := conversationBody(r, limit)
		if e != nil {
			return nil, e
		}
		authorize := func(ctx context.Context, _ pgx.Tx) (operationspermissions.Actor, error) {
			fresh, e := h.Authority.AuthorizeOperations(r.WithContext(ctx), true, "")
			fresh.RequestID = &requestID
			return fresh, e
		}
		if execution == nil {
			return s.Create(r.Context(), actor, input, authorize)
		}
		if execution[2] == "events" {
			return s.Change(r.Context(), actor, execution[1], input, authorize)
		}
		kind := execution[2]
		if kind == "runs" {
			kind = "run"
		}
		return h.Runtime.Command(r.Context(), actor, execution[1], kind, input, authorize)
	}
	if operation != nil {
		return h.Runtime.Operation(r.Context(), actor, operation[1])
	}
	if execution != nil {
		return h.Runtime.Get(r.Context(), actor, execution[1])
	}
	if r.URL.Path == "/v1/operations/agentos/options" {
		return s.Options(r.Context(), actor)
	}
	return s.List(r.Context(), actor)
}
