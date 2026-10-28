package filegovernance

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

func urlValues(r *http.Request) (url.Values, error) { return url.ParseQuery(r.URL.RawQuery) }

type Handler struct {
	Service *Service
	Next    http.Handler
}

const routeUUID = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

var fileRoute = regexp.MustCompile(`^/v1/operations/files/(chat|forum)/(` + routeUUID + `)(?:/(retry|access))?$`)
var planRoute = regexp.MustCompile(`^/v1/operations/files/cleanup/plans/(` + routeUUID + `)(?:/(approve|cancel))?$`)
var accessOperationRoute = regexp.MustCompile(`^/v1/operations/files/access/operations/(` + routeUUID + `)$`)
var cleanupOperationRoute = regexp.MustCompile(`^/v1/operations/files/cleanup/operations/(` + routeUUID + `)$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	matched := path == "/v1/operations/files" || path == "/v1/operations/files/summary" || path == "/v1/operations/files/cleanup/candidates" || path == "/v1/operations/files/cleanup/plans" || fileRoute.MatchString(path) || planRoute.MatchString(path) || accessOperationRoute.MatchString(path) || cleanupOperationRoute.MatchString(path)
	if !matched {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", id)
	result, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		result = Object{"error": fault.Code(e), "requestId": id}
	}
	json.NewEncoder(w).Encode(result)
}
func httpBody(r *http.Request, max int64) (Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > max {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(b) || !json.Valid(b) {
		return nil, fail("invalid_json", 409)
	}
	x, e := parseObject(b)
	if e != nil {
		return nil, fail("invalid_request", 409)
	}
	return x, nil
}
func httpQuery(r *http.Request, allowed []string, max, status int) (Object, error) {
	if len(r.URL.RawQuery)+1 > max {
		return nil, fail("invalid_operations_request", status)
	}
	q, e := urlValues(r)
	if e != nil {
		return nil, fail("invalid_operations_request", status)
	}
	out := Object{}
	for key, values := range q {
		if !has(allowed, key) || len(values) != 1 {
			return nil, fail("invalid_operations_request", status)
		}
		if key == "limit" {
			n, e := strconv.ParseFloat(values[0], 64)
			if e != nil {
				out[key] = nil
			} else {
				out[key] = n
			}
		} else {
			out[key] = values[0]
		}
	}
	return out, nil
}
func (h Handler) dispatch(r *http.Request, id string) (Object, error) {
	s := h.Service
	if s == nil || s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	path := r.URL.Path
	file, plan := fileRoute.FindStringSubmatch(path), planRoute.FindStringSubmatch(path)
	accessOp, cleanupOp := accessOperationRoute.FindStringSubmatch(path), cleanupOperationRoute.FindStringSubmatch(path)
	candidates := path == "/v1/operations/files/cleanup/candidates"
	plans := path == "/v1/operations/files/cleanup/plans"
	cleanup := candidates || plans || plan != nil || cleanupOp != nil
	create := plans && r.Method == "POST"
	decision := ""
	if plan != nil {
		decision = plan[2]
	}
	write := create || decision != "" || file != nil && file[3] != ""
	if r.Method != func() string {
		if write {
			return "POST"
		}
		return "GET"
	}() || write && r.URL.RawQuery != "" || accessOp != nil && r.URL.RawQuery != "" {
		return nil, fail("not_found", 404)
	}
	action := "files.read"
	if create || decision == "cancel" {
		action = "files.cleanup.plan"
	} else if decision == "approve" {
		action = "files.cleanup.approve"
	} else if file != nil && file[3] == "retry" {
		action = ""
	}
	actor, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		return nil, e
	}
	actor.RequestID = &id
	if file != nil && file[3] == "access" {
		input, e := httpBody(r, 8192)
		if e != nil {
			return nil, e
		}
		input, e = ParseAccessChange(input)
		if e != nil {
			return nil, fail("invalid_operations_file_access", 400)
		}
		actor, e = s.Authority.AuthorizeOperations(r, true, "files.access."+str(input, "action"))
		if e != nil {
			return nil, e
		}
		actor.RequestID = &id
		return s.ChangeAccess(r.Context(), actor, file[1], file[2], input)
	}
	if cleanup {
		allowed := []string{}
		if candidates {
			allowed = []string{"kind", "after", "limit"}
		} else if plans && !write {
			allowed = []string{"after", "limit"}
		}
		query, e := httpQuery(r, allowed, 4096, 400)
		if e != nil {
			return nil, e
		}
		if create {
			input, e := httpBody(r, 262144)
			if e != nil {
				return nil, e
			}
			return s.CreateCleanup(r.Context(), actor, input)
		}
		if decision != "" {
			input, e := httpBody(r, 2048)
			if e != nil {
				return nil, e
			}
			if decision == "approve" {
				return s.ApproveCleanup(r.Context(), actor, plan[1], input)
			}
			return s.CancelCleanup(r.Context(), actor, plan[1], input)
		}
		if candidates {
			return s.CleanupCandidates(r.Context(), actor, query)
		}
		if plans {
			return s.CleanupPlans(r.Context(), actor, query)
		}
		if plan != nil {
			return s.CleanupPlan(r.Context(), actor, plan[1])
		}
		return s.CleanupOperation(r.Context(), actor, cleanupOp[1])
	}
	if accessOp != nil {
		return s.AccessOperation(r.Context(), actor, accessOp[1])
	}
	if file != nil {
		if r.URL.RawQuery != "" {
			return nil, fail("invalid_operations_request", 409)
		}
		if file[3] == "retry" {
			input, e := httpBody(r, 16384)
			if e != nil {
				return nil, e
			}
			return s.Retry(r.Context(), actor, file[1], file[2], input)
		}
		return s.Get(r.Context(), actor, file[1], file[2])
	}
	allowed := []string{"kind", "state", "processing", "issue"}
	if path == "/v1/operations/files" {
		allowed = append(allowed, "after", "limit")
	}
	query, e := httpQuery(r, allowed, 8192, 409)
	if e != nil {
		return nil, e
	}
	if strings.HasSuffix(path, "/summary") {
		return s.Summary(r.Context(), actor, query)
	}
	return s.List(r.Context(), actor, query)
}
