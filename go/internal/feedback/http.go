package feedback

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

// HTTPIdentity must verify the original portal cookie, origin, CSRF, current
// account lifecycle and role source. Its transaction authority remains bound to
// that authenticated request. No untrusted role/subject header is accepted here.
type HTTPIdentity interface {
	Account(*http.Request, bool) (string, Authorization, error)
	Operator(*http.Request, bool, string) (string, Authorization, error)
}
type Handler struct {
	Service  *Service
	Identity HTTPIdentity
	Next     http.Handler
}

func parameters(q url.Values, allowed ...string) (map[string]string, error) {
	out := map[string]string{}
	valid := map[string]bool{}
	for _, k := range allowed {
		valid[k] = true
	}
	for k, v := range q {
		if !valid[k] || len(v) != 1 {
			return nil, invalid()
		}
		out[k] = v[0]
	}
	return out, nil
}
func body(r *http.Request, max int64) ([]byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > max {
		return nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(b) {
		return nil, fault.New("invalid_json", 400)
	}
	var v map[string]json.RawMessage
	if json.Unmarshal(b, &v) != nil || v == nil {
		return nil, fault.New("invalid_json", 400)
	}
	return b, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/v1/")
	parts := strings.Split(path, "/")
	account := len(parts) >= 2 && parts[0] == "account" && parts[1] == "feedback"
	management := len(parts) >= 2 && parts[0] == "operations" && parts[1] == "feedback"
	ownerData := len(parts) >= 3 && parts[0] == "account" && parts[1] == "data" && parts[2] == "feedback"
	if !strings.HasPrefix(r.URL.Path, "/v1/") || !account && !management && !ownerData {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	requestID := uuid.NewString()
	w.Header().Set("X-Request-ID", requestID)
	if ownerData {
		h.ownerDataHTTP(w, r, parts, requestID)
		return
	}
	if h.attachmentHTTP(w, r, parts, account, requestID) {
		return
	}
	result, status, e := h.dispatch(r, parts, account, requestID)
	if e != nil {
		status = fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		result = Object{"error": fault.Code(e), "requestId": requestID}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}
func (h Handler) dispatch(r *http.Request, p []string, account bool, requestID string) (Object, int, error) {
	missing := func() (Object, int, error) { return nil, 404, fault.New("not_found", 404) }
	write := account && len(p) == 2 || !account && len(p) == 4 && p[3] == "events"
	want := "GET"
	if write {
		want = "POST"
	}
	if r.Method != want {
		return missing()
	}
	receipt := len(p) == 4 && account && p[2] == "operations" || len(p) == 5 && !account && p[3] == "operations"
	if (write || receipt) && r.URL.RawQuery != "" {
		return missing()
	}
	if h.Service == nil {
		return nil, 503, fault.New("feedback_service_unavailable", 503)
	}
	if h.Identity == nil {
		if account {
			return nil, 503, fault.New("official_account_unavailable", 503)
		}
		return nil, 503, fault.New("business_admin_unavailable", 503)
	}
	s := *h.Service
	s.RequestID = requestID
	var subject string
	var e error
	if account {
		subject, s.Authority, e = h.Identity.Account(r, write)
	} else {
		permission := "feedback.read"
		if write {
			permission = "feedback.update"
		}
		subject, s.Authority, e = h.Identity.Operator(r, write, permission)
	}
	if e != nil {
		return nil, fault.Status(e), e
	}
	ctx := r.Context()
	if account {
		if len(p) == 2 {
			b, e := body(r, 32768)
			if e != nil {
				return nil, 400, e
			}
			out, e := s.Submit(ctx, subject, b)
			status := 201
			if out["replayed"] == true {
				status = 200
			}
			return out, status, e
		}
		if receipt && uuidPattern.MatchString(p[3]) {
			out, e := s.SubmissionOperation(ctx, subject, strings.ToLower(p[3]))
			return out, 200, e
		}
		return missing()
	}
	if len(p) == 2 {
		v, e := parameters(r.URL.Query(), "query", "category", "module", "state", "days", "after", "limit")
		if e != nil {
			return nil, 400, e
		}
		limit := 30
		if value, ok := v["limit"]; ok {
			n, e := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if e != nil || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < 1 || n > 100 {
				return nil, 400, invalid()
			}
			limit = int(n)
		}
		if value, ok := v["days"]; ok && value != "all" {
			n, e := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if e != nil || n != 7 && n != 28 {
				return nil, 400, invalid()
			}
			v["days"] = strconv.Itoa(int(n))
		}
		for _, key := range []string{"category", "module", "state", "after"} {
			if value, ok := v[key]; ok && value == "" {
				return nil, 400, invalid()
			}
		}
		out, e := s.List(ctx, subject, Query{Query: v["query"], Category: v["category"], Module: v["module"], State: v["state"], Days: v["days"], After: v["after"], Limit: limit})
		return out, 200, e
	}
	if !uuidPattern.MatchString(p[2]) {
		return missing()
	}
	id := p[2]
	if len(p) == 3 {
		v, e := parameters(r.URL.Query(), "historyAfter")
		if e != nil {
			return nil, 400, e
		}
		if value, ok := v["historyAfter"]; ok && value == "" {
			return nil, 400, invalid()
		}
		out, e := s.Get(ctx, subject, id, v["historyAfter"])
		return out, 200, e
	}
	if write {
		b, e := body(r, 16384)
		if e != nil {
			return nil, 400, e
		}
		out, e := s.Update(ctx, subject, id, b)
		return out, 200, e
	}
	if receipt && uuidPattern.MatchString(p[4]) {
		out, e := s.Operation(ctx, subject, strings.ToLower(id), strings.ToLower(p[4]))
		return out, 200, e
	}
	return missing()
}
