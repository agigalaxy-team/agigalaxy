package operationsresources

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

var route = regexp.MustCompile(`^/v1/operations/resources/(projects|methods)(?:/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:/(visibility)|/operations/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?)?$`)

func timeStamp(n int64) time.Time { return time.Unix(n, 0).UTC() }
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m := route.FindStringSubmatch(r.URL.Path)
	if m == nil {
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
	out, e := h.dispatch(r, m, requestID)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": requestID}
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, m []string, id string) (Object, error) {
	s := h.Service
	if s == nil || s.Authority == nil {
		return nil, fail("business_admin_unavailable", 503)
	}
	write := m[3] != ""
	method := "GET"
	if write {
		method = "POST"
	}
	if r.Method != method || (write || m[4] != "") && r.URL.RawQuery != "" {
		return nil, fail("not_found", 404)
	}
	action := "resources.read"
	if write {
		action = ""
	}
	a, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		return nil, e
	}
	a.RequestID = &id
	if m[4] != "" {
		return s.CommandResult(r.Context(), a, m[1], m[2], m[4])
	}
	x := Object{}
	if write {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			return nil, fail("unsupported_media_type", 415)
		}
		raw, e := io.ReadAll(io.LimitReader(r.Body, 16385))
		if e != nil {
			return nil, e
		}
		if len(raw) > 16384 {
			return nil, fail("request_too_large", 413)
		}
		if !utf8.Valid(raw) || !json.Valid(raw) {
			return nil, fail("invalid_json", 409)
		}
		if e = protocol.Decode(raw, &x); e != nil || x == nil {
			return nil, fail("invalid_request", 409)
		}
		return s.Visibility(r.Context(), a, m[1], m[2], x)
	}
	if m[2] != "" {
		if r.URL.RawQuery != "" {
			return nil, invalid()
		}
		return s.Get(r.Context(), a, m[1], m[2])
	}
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, invalid()
	}
	for k, v := range q {
		if !has([]string{"after", "limit", "state"}, k) || len(v) != 1 {
			return nil, invalid()
		}
		if k == "limit" {
			n, e := strconv.ParseFloat(v[0], 64)
			if e != nil {
				return nil, invalid()
			}
			x[k] = n
		} else {
			x[k] = v[0]
		}
	}
	return s.List(r.Context(), a, m[1], x)
}
