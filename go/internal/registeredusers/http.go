package registeredusers

import (
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
		if !has(keys, k) || len(v) != 1 {
			return nil, invalid()
		}
		if has(numbers, k) {
			s := trim(v[0])
			n := float64(0)
			var err error
			if s != "" {
				if len(s) > 2 && (s[:2] == "0x" || s[:2] == "0X" || s[:2] == "0b" || s[:2] == "0B" || s[:2] == "0o" || s[:2] == "0O") {
					var i uint64
					i, err = strconv.ParseUint(s, 0, 64)
					n = float64(i)
				} else {
					n, err = strconv.ParseFloat(s, 64)
				}
			}
			if err != nil {
				return nil, invalid()
			}
			out[k] = n
		} else {
			out[k] = v[0]
		}
	}
	return out, nil
}

var targetRoute = regexp.MustCompile(`(?i)^/v1/operations/registered-users/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:/(commands|history))?$`)
var operationRoute = regexp.MustCompile(`(?i)^/v1/operations/registered-users/operations/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const root = "/v1/operations/registered-users"
	path := r.URL.EscapedPath()
	if path != root && !strings.HasPrefix(path, root+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			writeResponse(w, nil, fail("not_found", 404))
		}
		return
	}
	match, receipt := targetRoute.FindStringSubmatch(path), operationRoute.FindStringSubmatch(path)
	tail := ""
	if match != nil {
		tail = match[2]
	}
	write := r.Method == "POST" && tail == "commands"
	read := r.Method == "GET" && (path == root || receipt != nil || match != nil && tail != "commands")
	if !write && !read || r.URL.RawQuery != "" && (write || receipt != nil || match != nil && tail == "") {
		writeResponse(w, nil, fail("not_found", 404))
		return
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		writeResponse(w, nil, fail("operations_authorization_unavailable", 503))
		return
	}
	a, e := s.Authority.AuthorizeOperations(r, write, "accounts.registered.read")
	if e != nil {
		writeResponse(w, nil, e)
		return
	}
	var out Object
	if write {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			writeResponse(w, nil, fail("unsupported_media_type", 415))
			return
		}
		b, e := io.ReadAll(io.LimitReader(r.Body, 8193))
		if e != nil || len(b) > 8192 {
			writeResponse(w, nil, fail("request_too_large", 413))
			return
		}
		var input Object
		if !utf8.Valid(b) || !json.Valid(b) {
			writeResponse(w, nil, fail("invalid_json", 400))
			return
		}
		if json.Unmarshal(b, &input) != nil || input == nil {
			writeResponse(w, nil, fail("invalid_request", 400))
			return
		}
		if CommandActions[str(input["kind"])] == "" {
			writeResponse(w, nil, invalid())
			return
		}
		out, e = s.Command(r.Context(), a, match[1], input, func() (Actor, error) { return s.Authority.AuthorizeOperations(r, true, "") })
	} else if receipt != nil {
		out, e = s.Operation(r.Context(), a, receipt[1])
	} else if match != nil {
		if tail == "history" {
			var x Object
			x, e = query(r, []string{"after", "limit"}, []string{"limit"})
			if e == nil {
				out, e = s.History(r.Context(), a, match[1], x)
			}
		} else {
			out, e = s.Detail(r.Context(), a, match[1])
		}
	} else {
		var x Object
		x, e = query(r, ListQuery, []string{"page", "pageSize"})
		if e == nil {
			out, e = s.List(r.Context(), a, x)
		}
	}
	writeResponse(w, out, e)
}
