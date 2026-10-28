package operationsmodels

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Handler struct {
	Service *Service
	Native  *NativeClient
	Next    http.Handler
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
func requestBody(r *http.Request) (Object, []byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 65537))
	if e != nil || len(raw) > 65536 {
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
	if r.URL.RawQuery != "" && protocol.TextLength("?"+r.URL.RawQuery) > 2048 {
		return nil, invalid()
	}
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

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const root = "/v1/operations/model-settings"
	path := r.URL.EscapedPath()
	if path == "/v1/internal/models/authorize" {
		h.internal(w, r)
		return
	}
	if path != root && !strings.HasPrefix(path, root+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			respond(w, nil, fail("not_found", 404))
		}
		return
	}
	part := strings.TrimPrefix(path, root+"/")
	write := r.Method == "POST"
	kind, id, action := "", "", "models.read"
	if write {
		switch part {
		case "draft", "credentials":
			kind, action = part, "models.configure"
		case "apply":
			kind, action = part, "models.apply"
		}
	} else if r.Method == "GET" {
		if has([]string{"overview", "history", "usage"}, part) {
			kind = part
		} else if strings.HasPrefix(part, "operations/") {
			if v, ok := parseUUID(strings.TrimPrefix(part, "operations/")); ok {
				kind, id = "operation", v
			}
		}
	}
	if kind == "" {
		respond(w, nil, fail("not_found", 404))
		return
	}
	if write && (r.URL.RawQuery != "" || r.URL.ForceQuery) {
		respond(w, nil, invalid())
		return
	}
	keys := []string{}
	if kind == "history" {
		keys = []string{"after", "limit"}
	} else if kind == "usage" {
		keys = []string{"days"}
	}
	query, e := requestQuery(r, keys)
	if e != nil {
		respond(w, nil, e)
		return
	}
	for _, k := range []string{"days", "limit"} {
		if v, ok := query[k]; ok {
			n, e := queryNumber(str(v))
			if e != nil {
				respond(w, nil, invalid())
				return
			}
			query[k] = n
		}
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		respond(w, nil, fail("model_settings_unavailable", 503))
		return
	}
	a, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		respond(w, nil, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	var result Object
	if write {
		input, _, err := requestBody(r)
		if err != nil {
			respond(w, nil, err)
			return
		}
		authorize := func() (Actor, error) { return s.Authority.AuthorizeOperations(r, true, "") }
		switch kind {
		case "draft":
			result, e = s.SaveDraft(r.Context(), a, input, authorize)
		case "apply":
			result, e = s.Apply(r.Context(), a, input, authorize)
		case "credentials":
			result, e = s.ProvisionCredential(r.Context(), a, input, authorize)
		}
	} else {
		switch kind {
		case "overview":
			result, e = s.Overview(r.Context(), a)
		case "history":
			result, e = s.History(r.Context(), a, query)
		case "usage":
			result, e = s.Usage(r.Context(), a, query)
		case "operation":
			result, e = s.Operation(r.Context(), a, id)
		}
	}
	respond(w, result, e)
}
func queryNumber(s string) (float64, error) {
	s = trim(s)
	if s == "" {
		return 0, nil
	}
	if len(s) > 2 && (s[:2] == "0x" || s[:2] == "0X" || s[:2] == "0b" || s[:2] == "0B" || s[:2] == "0o" || s[:2] == "0O") {
		n, e := strconv.ParseUint(s, 0, 64)
		return float64(n), e
	}
	return strconv.ParseFloat(s, 64)
}
func (h Handler) internal(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		respond(w, nil, fail("not_found", 404))
		return
	}
	if h.Service == nil || h.Native == nil {
		respond(w, nil, fail("model_settings_native_not_configured", 503))
		return
	}
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil || !has([]string{"127.0.0.1", "::1", "::ffff:127.0.0.1"}, host) {
		respond(w, nil, fail("model_settings_service_denied", 401))
		return
	}
	verified, e := h.Native.VerifyService(r)
	if e != nil {
		respond(w, nil, e)
		return
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		respond(w, nil, fail("unsupported_media_type", 415))
		return
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 65537))
	if e != nil || len(raw) > 65536 {
		respond(w, nil, fail("request_too_large", 413))
		return
	}
	if !utf8.Valid(raw) {
		respond(w, nil, fail("invalid_json", 400))
		return
	}
	if e = h.Native.VerifyBody(verified, raw); e != nil {
		respond(w, nil, e)
		return
	}
	var input Object
	if json.Unmarshal(raw, &input) != nil || input == nil {
		respond(w, nil, fail("invalid_json", 400))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	result, e := h.Service.AuthorizeNative(r.Context(), input)
	respond(w, result, e)
}
