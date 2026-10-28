package operationspermissions

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

var routeID = regexp.MustCompile(`(?i)^(roles|operations)/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
var delegationOperation = regexp.MustCompile(`(?i)^ai-delegation/operations/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
var sourceVersion = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	root := "/v1/operations/permissions"
	if r.URL.EscapedPath() != root && !strings.HasPrefix(r.URL.EscapedPath(), root+"/") {
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
	out, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": id})
		return
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, requestID string) (Object, error) {
	part := strings.TrimPrefix(r.URL.EscapedPath(), "/v1/operations/permissions/")
	match := routeID.FindStringSubmatch(part)
	delegationMatch := delegationOperation.FindStringSubmatch(part)
	write := r.Method == "POST"
	method, action := "", "permissions.read"
	if write {
		switch part {
		case "roles":
			method, action = "save-role", "permissions.roles.write"
		case "assignments":
			method, action = "save-assignment", "permissions.assignments.write"
		case "automation":
			method, action = "save-automation", "permissions.automation.write"
		case "ai-delegation":
			method, action = "save-delegation", "ai.delegation.configure"
		}
	} else if r.Method == "GET" {
		switch part {
		case "catalog", "catalog/lease", "roles", "personnel", "history":
			method = part
		case "automation":
			method = "automation"
		case "ai-delegation":
			method, action = "delegation", "ai.delegation.read"
		}
		if len(match) > 0 {
			method = match[1]
		}
		if len(delegationMatch) > 0 {
			method, action = "delegation-operation", "ai.delegation.read"
		}
	}
	if method == "" || r.URL.RawQuery != "" && (write || method != "history" && method != "catalog/lease") {
		return nil, fail("not_found", 404)
	}
	query, e := r.URL.Query(), error(nil)
	if method == "catalog/lease" {
		if len(query) != 1 || len(query["version"]) != 1 || !sourceVersion.MatchString(query.Get("version")) {
			return nil, invalid()
		}
	}
	history := Object{}
	if method == "history" {
		if len(r.URL.RawQuery)+1 > 8192 {
			return nil, invalid()
		}
		for k, v := range query {
			if !contains([]string{"after", "limit", "resourceId", "targetOperatorId"}, k) || len(v) != 1 {
				return nil, invalid()
			}
			if k == "limit" {
				n, err := javascriptNumber(v[0])
				if err != nil {
					return nil, invalid()
				}
				history[k] = n
			} else {
				history[k] = v[0]
			}
		}
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	actor, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		return nil, e
	}
	actor.RequestID = &requestID
	var input Object
	if write {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			return nil, fail("unsupported_media_type", 415)
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 32769))
		if err != nil {
			return nil, err
		}
		if len(raw) > 32768 {
			return nil, fail("request_too_large", 413)
		}
		if !utf8.Valid(raw) || !json.Valid(raw) {
			return nil, fail("invalid_json", 400)
		}
		if json.Unmarshal(raw, &input) != nil || input == nil {
			return nil, fail("invalid_request", 400)
		}
	}
	switch method {
	case "delegation":
		return s.Delegation(r.Context(), actor)
	case "delegation-operation":
		return s.DelegationOperation(r.Context(), actor, delegationMatch[1])
	case "save-delegation":
		return s.SaveDelegation(r.Context(), actor, input)
	case "automation":
		return s.Automation(r.Context(), actor)
	case "save-automation":
		return s.SaveAutomation(r.Context(), actor, input)
	case "catalog":
		return s.Catalog(r.Context(), actor)
	case "catalog/lease":
		return s.CatalogLease(r.Context(), actor, query.Get("version"))
	case "roles":
		if len(match) > 0 {
			return s.Role(r.Context(), actor, match[2])
		}
		return s.Roles(r.Context(), actor)
	case "personnel":
		return s.Personnel(r.Context(), actor)
	case "history":
		return s.History(r.Context(), actor, history)
	case "operations":
		return s.Operation(r.Context(), actor, match[2])
	case "save-role":
		return s.SaveRole(r.Context(), actor, input)
	case "save-assignment":
		return s.SaveAssignment(r.Context(), actor, input)
	}
	return nil, fail("not_found", 404)
}
