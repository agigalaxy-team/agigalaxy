package managementaccounts

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func protocolQueryLength(raw string) int {
	if raw == "" {
		return 0
	}
	return protocol.TextLength("?" + raw)
}
func urlQuery(r *http.Request) (url.Values, error) {
	// URLSearchParams treats semicolons as values, and preserves malformed
	// percent escapes rather than selecting a different key or splitting them.
	decode := func(s string) string {
		out := ""
		hex := func(c byte) bool { return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' }
		for i := 0; i < len(s); i++ {
			if s[i] == '%' && (i+2 >= len(s) || !hex(s[i+1]) || !hex(s[i+2])) {
				out += "%25"
			} else {
				out += string(s[i])
			}
		}
		v, _ := url.QueryUnescape(out)
		return strings.ToValidUTF8(v, "\ufffd")
	}
	v := url.Values{}
	for _, pair := range strings.Split(r.URL.RawQuery, "&") {
		if pair == "" {
			continue
		}
		parts := strings.SplitN(pair, "=", 2)
		key := decode(parts[0])
		value := ""
		if len(parts) == 2 {
			value = decode(parts[1])
		}
		v[key] = append(v[key], value)
	}
	return v, nil
}

var targetRoute = regexp.MustCompile(`^/v1/operations/management-accounts/([a-f0-9]{64})(?:/(commands|history|assignments))?$`)
var operationRoute = regexp.MustCompile(`(?i)^/v1/operations/management-accounts/operations/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
var assignmentOperationRoute = regexp.MustCompile(`(?i)^/v1/operations/management-accounts/([a-f0-9]{64})/assignments/operations/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)

func writeResponse(w http.ResponseWriter, out any, e error) {
	w.Header().Set("Content-Type", "application/json")
	if e != nil {
		w.WriteHeader(fault.Status(e))
		json.NewEncoder(w).Encode(Object{"error": fault.Code(e)})
		return
	}
	json.NewEncoder(w).Encode(out)
}
func query(r *http.Request, keys, numbers []string) (Object, error) {
	if protocolQueryLength(r.URL.RawQuery) > 4096 {
		return nil, invalid()
	}
	values, e := urlQuery(r)
	if e != nil {
		return nil, e
	}
	out := Object{}
	for k, v := range values {
		if !includes(keys, k) || len(v) != 1 {
			return nil, invalid()
		}
		if includes(numbers, k) {
			if !regexp.MustCompile(`^[0-9]{1,7}$`).MatchString(v[0]) {
				return nil, invalid()
			}
			n, _ := strconv.Atoi(v[0])
			out[k] = n
		} else {
			out[k] = v[0]
		}
	}
	return out, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const root = "/v1/operations/management-accounts"
	path := r.URL.EscapedPath()
	if path != root && !strings.HasPrefix(path, root+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			writeResponse(w, nil, fault.New("not_found", 404))
		}
		return
	}
	match, op, assignmentOp := targetRoute.FindStringSubmatch(path), operationRoute.FindStringSubmatch(path), assignmentOperationRoute.FindStringSubmatch(path)
	tail := ""
	if match != nil {
		tail = match[2]
	}
	create := r.Method == "POST" && path == root
	write := create || r.Method == "POST" && (tail == "commands" || tail == "assignments")
	read := r.Method == "GET" && (path == root || op != nil || assignmentOp != nil || match != nil && tail != "commands" && tail != "assignments")
	if !write && !read || r.URL.RawQuery != "" && (write || op != nil || assignmentOp != nil || match != nil && tail == "") {
		writeResponse(w, nil, fault.New("not_found", 404))
		return
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		writeResponse(w, nil, nativeError("operations_authorization_unavailable"))
		return
	}
	a, e := s.Authority.AuthorizeOperations(r, write, "management.accounts.read")
	if e != nil {
		writeResponse(w, nil, e)
		return
	}
	authorize := func(_ context.Context) (Actor, error) { return s.Authority.AuthorizeOperations(r, true, "") }
	var out Object
	if write {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			writeResponse(w, nil, fault.New("unsupported_media_type", 415))
			return
		}
		b, err := io.ReadAll(io.LimitReader(r.Body, 16385))
		if err != nil || len(b) > 16384 {
			writeResponse(w, nil, fault.New("request_too_large", 413))
			return
		}
		var input Object
		if !utf8.Valid(b) || !json.Valid(b) {
			writeResponse(w, nil, fault.New("invalid_json", 400))
			return
		}
		if json.Unmarshal(b, &input) != nil || input == nil {
			writeResponse(w, nil, fault.New("invalid_request", 400))
			return
		}
		if create {
			out, e = s.Create(r.Context(), a, input, authorize)
		} else if tail == "assignments" {
			out, e = s.Assignment(r.Context(), a, match[1], input, authorize)
		} else {
			out, e = s.Command(r.Context(), a, match[1], input, authorize)
		}
	} else if op != nil {
		out, e = s.Operation(r.Context(), a, op[1])
	} else if assignmentOp != nil {
		out, e = s.AssignmentOperation(r.Context(), a, assignmentOp[1], assignmentOp[2])
	} else if match != nil {
		if tail == "history" {
			var input Object
			input, e = query(r, []string{"after", "limit"}, []string{"limit"})
			if e == nil {
				out, e = s.History(r.Context(), a, match[1], input)
			}
		} else {
			out, e = s.Detail(r.Context(), a, match[1])
		}
	} else {
		var input Object
		input, e = query(r, []string{"page", "pageSize", "query", "enabled", "roleId", "aiDomain", "sort"}, []string{"page", "pageSize"})
		if e == nil {
			out, e = s.List(r.Context(), a, input)
		}
	}
	writeResponse(w, out, e)
}
