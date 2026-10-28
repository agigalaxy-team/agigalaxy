package operationsaudit

import (
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
)

type Handler struct {
	Service   *Service
	Authority operationspermissions.Authority
	Next      http.Handler
}

var accountAuditPath = regexp.MustCompile(`^/v1/operations/users/([0-9a-f-]{36})/audit$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	account := accountAuditPath.FindStringSubmatch(r.URL.EscapedPath())
	if r.URL.EscapedPath() != "/v1/operations/audit" && account == nil {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-ID")
	if !validFormat(id, "uuid") {
		id = uuid.NewString()
		w.Header().Set("X-Request-ID", id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	result, e := h.dispatch(r, id, account)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		result = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(result)
}
func (h Handler) dispatch(r *http.Request, id string, account []string) (Object, error) {
	if r.Method != "GET" {
		return nil, fail("not_found", 404)
	}
	if h.Service == nil || h.Authority == nil {
		return nil, fail("business_admin_unavailable", 503)
	}
	actor, e := h.Authority.AuthorizeOperations(r, false, "audit.read")
	if e != nil {
		return nil, e
	}
	actor.RequestID = &id
	q := Object{}
	for key, values := range r.URL.Query() {
		if len(values) != 1 || !slices.Contains([]string{"accountId", "resourceId", "after", "limit", "action", "kind", "day", "query", "page", "pageSize", "snapshot", "sort"}, key) || account != nil && key == "accountId" {
			return nil, invalid()
		}
		if key == "limit" || key == "page" || key == "pageSize" {
			q[key] = queryNumber(values[0])
		} else {
			q[key] = values[0]
		}
	}
	if account != nil {
		q["accountId"] = account[1]
	}
	return h.Service.Audit(r.Context(), actor, q)
}
func queryNumber(value string) float64 {
	value = trim(value)
	if value == "" {
		return 0
	}
	if len(value) > 2 && value[0] == '0' {
		base := 0
		switch value[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base > 0 {
			n, e := strconv.ParseUint(value[2:], base, 64)
			if e != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	if strings.Contains(value, "_") {
		return math.NaN()
	}
	n, e := strconv.ParseFloat(value, 64)
	if e != nil {
		return math.NaN()
	}
	return n
}
