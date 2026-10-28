package publication

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
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/google/uuid"
)

type HTTPIdentity interface {
	Operator(*http.Request, bool, string) (string, feedback.Authorization, error)
}
type Handler struct {
	Commands *Commands
	Identity HTTPIdentity
	Next     http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	publications := path == "/v1/operations/content/publications"
	var publicationID, jobID, command string
	if strings.HasPrefix(path, "/v1/operations/content/publications/") {
		part := strings.TrimPrefix(path, "/v1/operations/content/publications/")
		if !strings.Contains(part, "/") {
			publicationID = part
		}
	}
	if strings.HasPrefix(path, "/v1/operations/jobs/content-publication/") {
		parts := strings.Split(strings.TrimPrefix(path, "/v1/operations/jobs/content-publication/"), "/")
		if len(parts) == 1 {
			jobID = parts[0]
		}
		if len(parts) == 2 {
			jobID, command = parts[0], parts[1]
		}
	}
	if !publications && publicationID == "" && jobID == "" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	requestID := uuid.NewString()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", requestID)
	fail := func(e error) {
		status := fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": requestID})
	}
	if h.Commands == nil || h.Commands.Pool == nil || h.Identity == nil {
		fail(fault.New("site_publication_unavailable", 503))
		return
	}
	write := publications && r.Method == "POST" || jobID != "" && (command == "cancel" || command == "retry") && r.Method == "POST"
	permission := "cms.read"
	if publications && write {
		permission = "cms.publish"
	}
	if jobID != "" {
		permission = "jobs.read"
		if write {
			permission = "jobs." + command
		}
	}
	if r.Method != "GET" && !write || publicationID != "" && r.Method != "GET" || jobID != "" && command != "" && !write {
		fail(fault.New("not_found", 404))
		return
	}
	operator, authority, e := h.Identity.Operator(r, write, permission)
	if e != nil {
		fail(e)
		return
	}
	c := *h.Commands
	c.Authority = authority
	c.RequestID = requestID
	query, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		fail(fault.New("invalid_operations_query", 400))
		return
	}
	var result Object
	if publications && write {
		if r.URL.RawQuery != "" {
			fail(fault.New("invalid_operations_query", 400))
			return
		}
		raw, e := commandBody(r, 1100000)
		if e != nil {
			fail(e)
			return
		}
		var fields map[string]json.RawMessage
		json.Unmarshal(raw, &fields)
		if len(fields) != 2 || fields["operationId"] == nil || fields["snapshot"] == nil {
			fail(fault.New("invalid_request", 400))
			return
		}
		result, e = c.Request(r.Context(), operator, raw)
		if e != nil {
			fail(e)
			return
		}
	} else if publications {
		for k, v := range query {
			if (k != "after" && k != "limit") || len(v) != 1 {
				fail(fault.New("invalid_operations_query", 400))
				return
			}
		}
		limit := 20
		if query.Has("limit") {
			n, err := strconv.ParseFloat(strings.TrimSpace(query.Get("limit")), 64)
			if err != nil || math.IsInf(n, 0) || math.IsNaN(n) || math.Trunc(n) != n || n < 1 || n > 100 {
				fail(fault.New("invalid_operations_query", 400))
				return
			}
			limit = int(n)
		}
		var after *string
		if query.Has("after") {
			v := query.Get("after")
			after = &v
		}
		result, e = c.List(r.Context(), operator, after, limit)
		if e != nil {
			fail(e)
			return
		}
	} else {
		if r.URL.RawQuery != "" || publicationID != "" && !routeUUID.MatchString(publicationID) || jobID != "" && !routeUUID.MatchString(jobID) {
			fail(fault.New("invalid_operations_query", 400))
			return
		}
		if publicationID != "" {
			result, e = c.Get(r.Context(), operator, publicationID)
		} else if !write {
			result, e = c.Job(r.Context(), operator, jobID)
		} else {
			raw, err := commandBody(r, 32768)
			if err != nil {
				fail(err)
				return
			}
			var value map[string]json.RawMessage
			if json.Unmarshal(raw, &value) != nil || value == nil || len(value) != 0 {
				fail(fault.New("invalid_request", 400))
				return
			}
			result, e = c.Control(r.Context(), operator, jobID, command)
		}
		if e != nil {
			fail(e)
			return
		}
	}
	json.NewEncoder(w).Encode(result)
}
func commandBody(r *http.Request, max int64) ([]byte, error) {
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
	var value map[string]json.RawMessage
	if json.Unmarshal(b, &value) != nil || value == nil {
		return nil, fault.New("invalid_json", 400)
	}
	return b, nil
}
