package systemsettings

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
	General *General
	Mail    *MailBridge
	Native  *NativeClient
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
	if protocolQueryLength(r.URL.RawQuery) > 2048 {
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

func body(r *http.Request, max int64) (Object, []byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, nil, fail("unsupported_media_type", 415)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil || int64(len(b)) > max {
		return nil, nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(b) || !json.Valid(b) {
		return nil, nil, fail("invalid_json", 400)
	}
	var o Object
	if json.Unmarshal(b, &o) != nil || o == nil {
		return nil, nil, fail("invalid_request", 400)
	}
	return o, b, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const root = "/v1/operations/system-settings"
	path := r.URL.EscapedPath()
	if path == "/v1/internal/system-settings/authorize" || path == "/v1/internal/system-settings/mail" {
		h.internal(w, r, path)
		return
	}
	if path != root && !strings.HasPrefix(path, root+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			writeResponse(w, nil, fail("not_found", 404))
		}
		return
	}
	part := "overview"
	if path != root {
		part = strings.TrimPrefix(path, root+"/")
	}
	pieces := strings.Split(part, "/")
	kind, section, id, action := "", "", "", "system.settings.read"
	write := r.Method == "POST"
	if r.Method == "GET" {
		switch {
		case part == "overview" || part == "advanced":
			kind = part
		case includes(sections, part):
			kind, section = "read", part
		case len(pieces) == 2 && pieces[0] == "operations" && wireUUID(pieces[1]):
			kind, id = "operation", pieces[1]
		case len(pieces) == 2 && includes(sections, pieces[0]) && pieces[1] == "history":
			kind, section = "history", pieces[0]
		case part == "general/publication":
			kind = "general-source"
		case len(pieces) == 3 && pieces[0] == "general" && pieces[1] == "operations" && wireUUID(pieces[2]):
			kind, id = "general-operation", pieces[2]
		}
	} else if write {
		if len(pieces) == 2 && includes(sections, pieces[0]) {
			switch pieces[1] {
			case "versions":
				kind, action = "save", "system.settings.configure"
			case "test":
				kind, action = "test", "system.settings.test"
			case "apply":
				kind, action = "apply", "system.settings.apply"
			}
			section = pieces[0]
		} else if part == "credentials" {
			kind, action = "credential", "system.settings.credentials.write"
		} else if part == "general/publish" {
			kind, action = "general-publish", "system.settings.apply"
		}
	}
	if kind == "" {
		writeResponse(w, nil, fail("not_found", 404))
		return
	}
	if write && r.URL.RawQuery != "" {
		writeResponse(w, nil, invalid())
		return
	}
	keys, numbers := []string{}, []string{}
	if kind == "history" {
		keys, numbers = []string{"after", "limit"}, []string{"limit"}
	}
	values, e := query(r, keys, numbers)
	if e != nil {
		writeResponse(w, nil, e)
		return
	}
	general := strings.HasPrefix(kind, "general-")
	s := h.Service
	if general {
		if h.General == nil || h.General.Settings == nil {
			writeResponse(w, nil, fail("system_settings_native_not_configured", 503))
			return
		}
		s = h.General.Settings
	}
	if s == nil || s.Authority == nil {
		writeResponse(w, nil, fail("system_settings_native_not_configured", 503))
		return
	}
	actor, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		writeResponse(w, nil, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	authorize := func() (Actor, error) { return s.Authority.AuthorizeOperations(r, true, "") }
	var result Object
	if write {
		input, _, err := body(r, 65536)
		if err != nil {
			writeResponse(w, nil, err)
			return
		}
		if kind == "general-publish" {
			result, e = h.General.Publish(r.Context(), actor, input, authorize)
		} else {
			if kind == "credential" {
				section = str(input["section"])
			}
			result, e = s.Command(r.Context(), actor, section, kind, input, authorize)
		}
	} else {
		switch kind {
		case "overview":
			result, e = s.Overview(r.Context(), actor)
		case "advanced":
			result, e = s.Advanced(r.Context(), actor)
		case "read":
			result, e = s.Read(r.Context(), actor, section)
		case "operation":
			result, e = s.Operation(r.Context(), actor, id)
		case "history":
			result, e = s.History(r.Context(), actor, section, values)
		case "general-source":
			result, e = h.General.Source(r.Context(), actor)
		case "general-operation":
			result, e = h.General.Operation(r.Context(), actor, id)
		}
	}
	writeResponse(w, result, e)
}
func wireUUID(v string) bool {
	if len(v) != 36 {
		return false
	}
	for i, c := range v {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}
func (h Handler) internal(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method != "POST" || r.URL.RawQuery != "" {
		writeResponse(w, nil, fail("not_found", 404))
		return
	}
	if h.Service == nil || h.Native == nil {
		writeResponse(w, nil, fail("system_settings_native_not_configured", 503))
		return
	}
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil || !includes([]string{"127.0.0.1", "::1", "::ffff:127.0.0.1"}, host) {
		writeResponse(w, nil, fail("maintenance_service_denied", 401))
		return
	}
	verified, e := h.Native.VerifyService(r)
	if e != nil {
		writeResponse(w, nil, e)
		return
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		writeResponse(w, nil, fail("unsupported_media_type", 415))
		return
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 65537))
	if e != nil || len(raw) > 65536 {
		writeResponse(w, nil, fail("request_too_large", 413))
		return
	}
	if !utf8.Valid(raw) {
		writeResponse(w, nil, fail("invalid_json", 400))
		return
	}
	if e = h.Native.VerifyBody(verified, raw); e != nil {
		writeResponse(w, nil, e)
		return
	}
	var input Object
	if json.Unmarshal(raw, &input) != nil || input == nil {
		writeResponse(w, nil, fail("invalid_json", 400))
		return
	}
	var result Object
	if path == "/v1/internal/system-settings/mail" {
		if h.Mail == nil {
			writeResponse(w, nil, fail("system_settings_consumer_not_configured", 503))
			return
		}
		result, e = h.Mail.Call(r.Context(), input)
	} else {
		result, e = h.Service.AuthorizeNative(r.Context(), input)
	}
	writeResponse(w, result, e)
}
