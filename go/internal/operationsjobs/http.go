package operationsjobs

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var decimalNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	kind, queue, id, action := "", "", "", ""
	if r.Method == "GET" && path == "/v1/operations/jobs" {
		kind = "list"
	}
	if r.Method == "GET" && path == "/v1/operations/search/failures" {
		kind = "failures"
	}
	if strings.HasPrefix(path, "/v1/operations/jobs/") {
		parts := strings.Split(strings.TrimPrefix(path, "/v1/operations/jobs/"), "/")
		if len(parts) >= 2 && has(aiQueues, parts[0]) && uuidPattern.MatchString(parts[1]) {
			queue, id = parts[0], parts[1]
			if len(parts) == 2 && r.Method == "GET" {
				kind = "get"
			}
			if len(parts) == 3 && r.Method == "POST" && has([]string{"cancel", "retry"}, parts[2]) {
				kind, action = "control", parts[2]
			}
		}
	}
	if strings.HasPrefix(path, "/v1/operations/search/failures/") {
		parts := strings.Split(strings.TrimPrefix(path, "/v1/operations/search/failures/"), "/")
		if len(parts) >= 1 && uuidPattern.MatchString(parts[0]) {
			id = parts[0]
			if len(parts) == 1 && r.Method == "GET" {
				kind = "failure"
			}
			if len(parts) == 2 && parts[1] == "retry" && r.Method == "POST" {
				kind = "search-retry"
			}
		}
	}
	if kind == "" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			respond(w, nil, fail("not_found", 404))
		}
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	s := h.Service
	if s == nil || s.Authority == nil {
		respond(w, nil, fail("operations_unavailable", 503))
		return
	}
	write := r.Method == "POST"
	permission := "jobs.read"
	if kind == "control" {
		permission = "jobs." + action
	}
	if kind == "failures" || kind == "failure" {
		permission = "search.read"
	}
	if kind == "search-retry" {
		permission = "search.retry"
	}
	actor, e := s.Authority.AuthorizeOperations(r, write, permission)
	if e != nil {
		respond(w, nil, e)
		return
	}
	var out Object
	if kind == "list" || kind == "failures" {
		q, after, limit, e := queryPage(r)
		if e != nil {
			respond(w, nil, e)
			return
		}
		if kind == "list" {
			out, e = s.List(r.Context(), actor, q, after, limit)
		} else {
			out, e = s.SearchFailures(r.Context(), actor, after, limit)
		}
		respond(w, out, e)
		return
	}
	if r.URL.RawQuery != "" {
		respond(w, nil, fail("invalid_operations_query", 400))
		return
	}
	switch kind {
	case "get":
		out, e = s.Get(r.Context(), actor, queue, id)
	case "failure":
		out, e = s.SearchFailure(r.Context(), actor, id)
	case "control":
		var body Object
		body, e = requestBody(r)
		if e == nil && !exact(body) {
			e = fail("invalid_request", 400)
		}
		if e == nil {
			out, e = s.Control(r.Context(), actor, queue, id, action)
		}
	case "search-retry":
		var body Object
		body, e = requestBody(r)
		if e == nil && !exact(body, "expectedGeneration") {
			e = fail("invalid_request", 400)
		}
		if e == nil {
			out, e = s.RetrySearch(r.Context(), actor, id, body)
		}
	}
	respond(w, out, e)
}
func respond(w http.ResponseWriter, out any, e error) {
	w.Header().Set("Content-Type", "application/json")
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e)})
		return
	}
	_ = json.NewEncoder(w).Encode(out)
}
func requestBody(r *http.Request) (Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil || len(raw) > 32768 {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 400)
	}
	var out Object
	if protocol.Decode(raw, &out) != nil || out == nil {
		return nil, fail("invalid_request", 400)
	}
	return out, nil
}

// Preserve URLSearchParams decoding: semicolons are values and malformed
// percent sequences remain text. Duplicate and unknown query keys are rejected.
func queryPage(r *http.Request) (string, string, int, error) {
	invalid := func() (string, string, int, error) { return "", "", 0, fail("invalid_operations_query", 400) }
	decode := func(s string) string {
		var b strings.Builder
		hex := func(c byte) bool { return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' }
		for i := 0; i < len(s); i++ {
			if s[i] == '%' && (i+2 >= len(s) || !hex(s[i+1]) || !hex(s[i+2])) {
				b.WriteString("%25")
			} else {
				b.WriteByte(s[i])
			}
		}
		v, _ := url.QueryUnescape(b.String())
		return strings.ToValidUTF8(v, "\ufffd")
	}
	values := map[string]string{}
	for _, part := range strings.Split(r.URL.RawQuery, "&") {
		if part == "" {
			continue
		}
		pair := strings.SplitN(part, "=", 2)
		key := decode(pair[0])
		if !has([]string{"queue", "after", "limit"}, key) {
			return invalid()
		}
		if _, ok := values[key]; ok {
			return invalid()
		}
		value := ""
		if len(pair) == 2 {
			value = decode(pair[1])
		}
		values[key] = value
	}
	queue := Queues[0]
	if q, ok := values["queue"]; ok {
		queue = q
	}
	after := values["after"]
	limit := 50
	if raw, ok := values["limit"]; ok {
		raw = trim(raw)
		if raw == "" {
			return invalid()
		}
		var n float64
		var e error
		if len(raw) > 2 && raw[0] == '0' && has([]string{"x", "X", "b", "B", "o", "O"}, raw[1:2]) {
			var value uint64
			value, e = strconv.ParseUint(raw[2:], map[byte]int{'x': 16, 'X': 16, 'b': 2, 'B': 2, 'o': 8, 'O': 8}[raw[1]], 64)
			n = float64(value)
		} else {
			if !decimalNumber.MatchString(raw) {
				return invalid()
			}
			n, e = strconv.ParseFloat(raw, 64)
		}
		if e != nil || !integer(n, 1) || n > 100 {
			return invalid()
		}
		limit = int(n)
	}
	if !has(Queues, queue) || after != "" && !uuidPattern.MatchString(after) {
		return invalid()
	}
	return queue, after, limit, nil
}
