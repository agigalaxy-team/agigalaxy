package operationsrules

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

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const root = "/v1/operations/rules"
	path := r.URL.EscapedPath()
	part := strings.TrimPrefix(path, root+"/")
	pieces := strings.Split(part, "/")
	kind, key := "", ""
	legacy := r.Method == "POST" && has(Keys[:3], part)
	if path == root && r.Method == "GET" {
		kind = "legacy-list"
	} else if r.Method == "GET" && has(Keys[:3], part) {
		kind, key = "legacy-get", part
	} else if len(pieces) == 2 && has(Keys[:3], pieces[0]) && pieces[1] == "history" && r.Method == "GET" {
		kind, key = "legacy-history", pieces[0]
	} else if part == "overview" {
		kind = "overview"
	} else if len(pieces) == 2 && pieces[0] == "operations" && uuidPattern.MatchString(pieces[1]) {
		kind, key = "operation", pieces[1]
	} else if len(pieces) == 2 && has([]string{"detail", "versions", "draft", "publish", "restore", "sample"}, pieces[1]) {
		kind, key = pieces[1], pieces[0]
	} else if legacy {
		kind, key = "legacy", part
	}
	if path != root && !strings.HasPrefix(path, root+"/") || kind == "" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			respond(w, nil, fail("not_found", 404))
		}
		return
	}
	write := r.Method == "POST"
	if r.Method != "GET" && !write || has([]string{"overview", "operation", "detail", "versions"}, kind) && write || has([]string{"draft", "publish", "restore", "sample"}, kind) && !write {
		respond(w, nil, fail("not_found", 404))
		return
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		respond(w, nil, fail("operations_rules_unavailable", 503))
		return
	}
	if kind != "overview" && kind != "operation" && kind != "legacy-list" && !has(Keys, key) {
		respond(w, nil, invalid())
		return
	}
	action := "rules.read"
	if has([]string{"draft", "publish", "restore", "legacy"}, kind) {
		action = "rules.write"
	}
	a, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		respond(w, nil, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if legacy {
		respond(w, nil, fail("operations_rule_explicit_publication_required", 409))
		return
	}
	keys := []string{}
	if kind == "versions" || kind == "legacy-history" {
		keys = []string{"after", "limit"}
	}
	query, e := requestQuery(r, keys)
	if e != nil {
		respond(w, nil, e)
		return
	}
	if v, ok := query["limit"]; ok {
		n, e := strconv.ParseFloat(trim(str(v)), 64)
		if trim(str(v)) == "" {
			n = 0
			e = nil
		}
		if e != nil {
			respond(w, nil, invalid())
			return
		}
		query["limit"] = n
	}
	var out Object
	switch kind {
	case "legacy-list":
		out, e = s.LegacyList(r.Context(), a)
	case "legacy-get":
		out, e = s.LegacyGet(r.Context(), a, key)
	case "legacy-history":
		out, e = s.LegacyHistory(r.Context(), a, key, query)
	case "overview":
		out, e = s.Overview(r.Context(), a)
	case "operation":
		out, e = s.Operation(r.Context(), a, key)
	case "detail":
		out, e = s.Get(r.Context(), a, key)
	case "versions":
		out, e = s.Versions(r.Context(), a, key, query)
	default:
		input, raw, err := requestBody(r, 262144)
		if err != nil {
			respond(w, nil, err)
			return
		}
		if !requestTextBytesValid(raw, key == "business-controls") {
			respond(w, nil, invalid())
			return
		}
		authorize := func() (Actor, error) { return s.Authority.AuthorizeOperations(r, true, "") }
		switch kind {
		case "draft":
			out, e = s.SaveDraft(r.Context(), a, key, input, authorize)
		case "publish":
			out, e = s.Publish(r.Context(), a, key, input, authorize)
		case "restore":
			out, e = s.Restore(r.Context(), a, key, input, authorize)
		case "sample":
			out, e = s.Sample(r.Context(), a, key, input)
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
