package operationsretention

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const root = "/v1/operations/retention"
	path := r.URL.EscapedPath()
	if path != root && !strings.HasPrefix(path, root+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			respond(w, nil, fail("not_found", 404))
		}
		return
	}
	read, write := r.Method == "GET", r.Method == "POST"
	part := strings.TrimPrefix(path, root)
	pieces := strings.Split(strings.TrimPrefix(part, "/"), "/")
	kind, id := "", ""
	if read && part == "" {
		kind = "status"
	} else if part == "/runs" && (read || write) {
		kind = "runs"
	} else if read && len(pieces) == 2 && uuidValid(pieces[1]) && has([]string{"runs", "operations"}, pieces[0]) {
		kind, id = pieces[0]+"-id", pieces[1]
	}
	if kind == "" {
		respond(w, nil, fail("not_found", 404))
		return
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		respond(w, nil, fail("operations_unavailable", 503))
		return
	}
	action := "retention.read"
	if write {
		action = "retention.request"
	}
	a, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		respond(w, nil, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	keys := []string{}
	if kind == "runs" && read {
		keys = []string{"after", "limit"}
	}
	q, e := requestQuery(r, keys)
	if e != nil {
		respond(w, nil, e)
		return
	}
	if v, ok := q["limit"]; ok {
		n, e := strconv.ParseFloat(trim(str(v)), 64)
		if trim(str(v)) == "" {
			n = 0
			e = nil
		}
		if e != nil {
			respond(w, nil, invalid())
			return
		}
		q["limit"] = n
	}
	var out Object
	switch kind {
	case "status":
		out, e = s.Status(r.Context(), a)
	case "runs-id":
		out, e = s.Get(r.Context(), a, id)
	case "operations-id":
		out, e = s.Operation(r.Context(), a, id)
	case "runs":
		if write {
			input, _, err := requestBody(r, 4096)
			if err != nil {
				respond(w, nil, err)
				return
			}
			out, e = s.Request(r.Context(), a, input)
		} else {
			out, e = s.List(r.Context(), a, q)
		}
	}
	respond(w, out, e)
}
func respond(w http.ResponseWriter, v any, e error) {
	w.Header().Set("Content-Type", "application/json")
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e)})
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}
func requestBody(r *http.Request, max int64) (Object, []byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil || int64(len(raw)) > max {
		return nil, nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, nil, fail("invalid_json", 400)
	}
	var o Object
	if json.Unmarshal(raw, &o) != nil || o == nil {
		return nil, nil, invalid()
	}
	return o, raw, nil
}

// URLSearchParams preserves malformed percent escapes and treats semicolons as values.
func requestQuery(r *http.Request, keys []string) (Object, error) {

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
	out := Object{}
	for _, pair := range strings.Split(r.URL.RawQuery, "&") {
		if pair == "" {
			continue
		}
		p := strings.SplitN(pair, "=", 2)
		k := decode(p[0])
		if !has(keys, k) {
			return nil, invalid()
		}
		if _, ok := out[k]; ok {
			return nil, invalid()
		}
		v := ""
		if len(p) == 2 {
			v = decode(p[1])
		}
		out[k] = v
	}
	return out, nil
}
