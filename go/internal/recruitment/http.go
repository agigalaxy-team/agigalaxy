package recruitment

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

var routeID = regexp.MustCompile(`^[0-9a-f-]{36}$`)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v2/recruitment/"), "/")
	read := strings.HasPrefix(r.URL.Path, "/v2/recruitment/") && len(parts) == 1 && routeID.MatchString(parts[0]) && r.Method == "GET"
	receipt := strings.HasPrefix(r.URL.Path, "/v2/recruitment/") && len(parts) == 2 && parts[1] == "receipt" && routeID.MatchString(parts[0]) && r.Method == "GET"
	writing := r.URL.Path == "/v2/recruitment" && r.Method == "POST"
	query := r.URL.Path == "/v2/recruitment/query" && r.Method == "POST"
	if !read && !receipt && !writing && !query {
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
	out, e := h.dispatch(r, id, parts, read, receipt, writing)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, id string, parts []string, read, receipt, writing bool) (Object, error) {
	s := h.Service
	if s == nil || s.Devices == nil {
		return nil, fail("recruitment_service_unavailable", 503)
	}
	var q Object
	if receipt {
		values, e := parseReceiptQuery(r, parts[0])
		if e != nil {
			return nil, e
		}
		q = values
	}
	a := Actor{RequestID: id}
	header := r.Header.Get("Authorization")
	if header != "" {
		if !strings.HasPrefix(header, "Bearer ") {
			return nil, fail("access_denied", 401)
		}
		device, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "history")
		if e != nil {
			return nil, e
		}
		a.Device = &device
	} else if writing || receipt {
		return nil, fail("access_denied", 401)
	}
	if read {
		return s.Get(r.Context(), a, parts[0])
	}
	if receipt {
		return s.OperationReceipt(r.Context(), a, encode(q))
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return nil, e
	}
	if len(raw) > 32768 {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 409)
	}
	if json.Unmarshal(raw, &q) != nil || q == nil {
		return nil, fail("invalid_request", 409)
	}
	if writing {
		if len(q) != 2 || !strict(q, "consentId", "payloadJson") {
			return nil, fail("invalid_request", 409)
		}
		return s.Submit(r.Context(), a, raw)
	}
	return s.Query(r.Context(), a, raw)
}
func parseReceiptQuery(r *http.Request, id string) (Object, error) {
	q, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil || len(q) != 2 {
		return nil, fail("invalid_recruitment_receipt_query", 409)
	}
	out := Object{"recruitmentId": id}
	for k, v := range q {
		if !has([]string{"operationId", "payloadHash"}, k) || len(v) != 1 {
			return nil, fail("invalid_recruitment_receipt_query", 409)
		}
		out[k] = v[0]
	}
	return out, nil
}
