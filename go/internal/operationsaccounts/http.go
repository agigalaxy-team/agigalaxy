package operationsaccounts

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"io"
	"net/http"
	"regexp"
	"strconv"
)

type Handler struct {
	Service   *Service
	Authority operationspermissions.Authority
	Next      http.Handler
}

var userPath = regexp.MustCompile(`^/v1/operations/users/([0-9a-f-]{36})(?:/(summary|links|type-history|restriction|restriction/release|type-change))?$`)
var operationPath = regexp.MustCompile(`(?i)^/v1/operations/users/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/operations/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	route, op := userPath.FindStringSubmatch(r.URL.EscapedPath()), operationPath.FindStringSubmatch(r.URL.EscapedPath())
	list := r.URL.EscapedPath() == "/v1/operations/users" || r.URL.EscapedPath() == "/v1/operations/users/summary"
	if route == nil && op == nil && !list {
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
	out, e := h.dispatch(r, route, op, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, route, op []string, requestID string) (Object, error) {
	action := ""
	if route != nil {
		action = route[2]
	}
	write := action == "restriction" || action == "restriction/release" || action == "type-change"
	method := "GET"
	if write {
		method = "POST"
	}
	if r.Method != method || write && r.URL.RawQuery != "" {
		return nil, fail("not_found", 404)
	}
	if h.Service == nil || h.Authority == nil {
		return nil, fail("business_admin_unavailable", 503)
	}
	permission := "accounts.read"
	if action == "summary" || r.URL.EscapedPath() == "/v1/operations/users/summary" {
		permission = "analytics.read"
	}
	if write {
		permission = map[string]string{"restriction": "accounts.restriction.apply", "restriction/release": "accounts.restriction.release", "type-change": "accounts.type.change"}[action]
	}
	actor, e := h.Authority.AuthorizeOperations(r, write, permission)
	if e != nil {
		return nil, e
	}
	actor.RequestID = &requestID
	if action == "summary" || r.URL.EscapedPath() == "/v1/operations/users/summary" {
		input := Object{}
		for key, values := range r.URL.Query() {
			if key != "days" || len(values) != 1 {
				return nil, invalid()
			}
			n, err := strconv.ParseFloat(trim(values[0]), 64)
			if err != nil {
				return nil, invalid()
			}
			input[key] = n
		}
		if action == "summary" {
			if h.Service.AccountSummary == nil {
				return nil, fail("business_admin_unavailable", 503)
			}
			return h.Service.AccountSummary(r.Context(), actor, route[1], input)
		}
		if h.Service.DirectorySummary == nil {
			return nil, fail("business_admin_unavailable", 503)
		}
		return h.Service.DirectorySummary(r.Context(), actor, input)
	}
	if r.URL.EscapedPath() == "/v1/operations/users" {
		query := Object{}
		for k, v := range r.URL.Query() {
			if len(v) != 1 {
				return nil, invalid()
			}
			if k == "limit" {
				n, err := strconv.ParseFloat(trim(v[0]), 64)
				if err != nil {
					return nil, invalid()
				}
				query[k] = n
			} else {
				query[k] = v[0]
			}
		}
		return h.Service.List(r.Context(), actor, query)
	}
	if op != nil {
		if r.URL.RawQuery != "" {
			return nil, invalid()
		}
		return h.Service.Operation(r.Context(), actor, op[1], op[2])
	}
	if !write {
		if action == "" {
			if r.URL.RawQuery != "" {
				return nil, invalid()
			}
			return h.Service.Get(r.Context(), actor, route[1])
		}
		input := Object{}
		query := r.URL.Query()
		for k, values := range query {
			if len(values) != 1 || k != "after" && k != "limit" {
				return nil, invalid()
			}
			if k == "limit" {
				n, err := strconv.ParseFloat(trim(values[0]), 64)
				if err != nil {
					return nil, invalid()
				}
				input[k] = n
			} else {
				input[k] = values[0]
			}
		}
		if action == "links" {
			return h.Service.Links(r.Context(), actor, route[1], input)
		}
		return h.Service.TypeHistory(r.Context(), actor, route[1], input)
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 16385))
	if e != nil {
		return nil, invalid()
	}
	if len(raw) > 16384 {
		return nil, fail("request_too_large", 413)
	}
	var input Object
	if protocol.Decode(raw, &input) != nil {
		return nil, invalid()
	}
	switch action {
	case "restriction":
		return h.Service.Restrict(r.Context(), actor, route[1], input)
	case "restriction/release":
		return h.Service.ReleaseRestriction(r.Context(), actor, route[1], input)
	default:
		return h.Service.ChangeType(r.Context(), actor, route[1], input)
	}
}
