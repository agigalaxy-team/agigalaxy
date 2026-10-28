package agentos

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"net/http"
	"regexp"
	"strconv"
)

type RunReadHandler struct {
	Service *RunOverview
	Next    http.Handler
}

var overviewRunPath = regexp.MustCompile(`^/v1/operations/agentos/runs/([A-Za-z0-9_-]{1,128})$`)
var overviewQueryNumber = regexp.MustCompile(`^[1-9][0-9]{0,5}$`)

func (h RunReadHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	detail := overviewRunPath.FindStringSubmatch(r.URL.Path)
	if r.URL.Path != "/v1/operations/agentos/runs" && detail == nil {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	requestID := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", requestID)
	out, e := h.dispatch(r, detail, requestID)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": requestID}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h RunReadHandler) dispatch(r *http.Request, detail []string, requestID string) (Object, error) {
	if r.Method != "GET" || detail != nil && r.URL.RawQuery != "" {
		return nil, fail("not_found", 404)
	}
	s := h.Service
	if s == nil || s.Human == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	a, e := s.Human.AuthorizeOperations(r, false, "audit.read")
	if e != nil {
		return nil, e
	}
	a.RequestID = &requestID
	if detail != nil {
		return s.RunDetail(r.Context(), a, detail[1])
	}
	if protocol.TextLength("?"+r.URL.RawQuery) > 2048 {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	q := Object{}
	for k, v := range r.URL.Query() {
		if len(v) != 1 {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
		switch k {
		case "page", "limit":
			if !overviewQueryNumber.MatchString(v[0]) {
				return nil, fail("invalid_operations_agentos_request", 400)
			}
			n, e := strconv.ParseInt(v[0], 10, 64)
			if e != nil {
				return nil, fail("invalid_operations_agentos_request", 400)
			}
			q[k] = n
		case "domain", "state":
			q[k] = v[0]
		default:
			return nil, fail("invalid_operations_agentos_request", 400)
		}
	}
	return s.Runs(r.Context(), a, q)
}
