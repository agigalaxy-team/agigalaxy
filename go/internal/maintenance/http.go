package maintenance

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"net"
	"net/http"
	"net/url"
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
		return nil, nil, failure("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 65537))
	if e != nil || len(raw) > 65536 {
		return nil, nil, failure("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, nil, failure("invalid_json", 400)
	}
	var o Object
	if json.Unmarshal(raw, &o) != nil || o == nil {
		return nil, nil, invalid()
	}
	return o, raw, nil
}

// URLSearchParams preserves malformed percent escapes and treats semicolons as values.
func requestQuery(r *http.Request, keys []string) (Object, error) {
	if r.URL.RawQuery != "" && protocol.TextLength("?"+r.URL.RawQuery) > 4096 {
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
		if !includes(keys, k) {
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
	const root = "/v1/operations/maintenance"
	path := r.URL.EscapedPath()
	if path == "/v1/internal/maintenance/authorize" || path == "/v1/internal/maintenance/chat-probe" {
		h.internal(w, r, path)
		return
	}
	if path != root && !strings.HasPrefix(path, root+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			respond(w, nil, failure("not_found", 404))
		}
		return
	}
	part := strings.TrimPrefix(path, root+"/")
	pieces := strings.Split(part, "/")
	kind, id, action := "", "", "maintenance.read"
	write := r.Method == "POST"
	if r.Method == "GET" {
		switch {
		case includes([]string{"overview", "logs", "backups", "restore-plans"}, part):
			kind = part
			if part == "logs" {
				action = "maintenance.logs.read"
			}
		case len(pieces) == 2 && pieces[0] == "backups" && pointPattern.MatchString(pieces[1]):
			kind, id = "backup", pieces[1]
		case len(pieces) == 2 && includes([]string{"restore-plans", "operations", "command-results"}, pieces[0]) && uuidPattern.MatchString(strings.ToLower(pieces[1])):
			kind, id = pieces[0]+"-item", strings.ToLower(pieces[1])
		}
	} else if write {
		action = ""
		switch {
		case part == "backups":
			kind = "run-backup"
		case part == "restore-plans":
			kind = "create-plan"
		case len(pieces) == 3 && pieces[0] == "restore-plans" && uuidPattern.MatchString(strings.ToLower(pieces[1])) && includes([]string{"approve", "execute", "cancel"}, pieces[2]):
			kind, id = pieces[2], strings.ToLower(pieces[1])
		}
	}
	if kind == "" {
		respond(w, nil, failure("not_found", 404))
		return
	}
	if write && (r.URL.RawQuery != "" || r.URL.ForceQuery) {
		respond(w, nil, invalid())
		return
	}
	keys := []string{}
	if part == "logs" {
		keys = []string{"component", "level", "period", "before", "limit"}
	} else if part == "backups" || part == "restore-plans" || kind == "restore-plans-item" {
		keys = []string{"after", "limit"}
	}
	query, e := requestQuery(r, keys)
	if e != nil {
		respond(w, nil, e)
		return
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		respond(w, nil, failure("maintenance_unavailable", 503))
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
		case "run-backup":
			result, e = s.RunBackup(r.Context(), a, input, authorize)
		case "create-plan":
			result, e = s.CreatePlan(r.Context(), a, input, authorize)
		case "approve":
			result, e = s.ApprovePlan(r.Context(), a, id, input, authorize)
		case "execute":
			result, e = s.ExecutePlan(r.Context(), a, id, input, authorize)
		case "cancel":
			result, e = s.CancelPlan(r.Context(), a, id, input, authorize)
		}
	} else {
		switch kind {
		case "overview":
			result, e = s.Overview(r.Context(), a)
		case "logs":
			result, e = s.Logs(r.Context(), a, query)
		case "backups":
			result, e = s.Backups(r.Context(), a, query)
		case "backup":
			result, e = s.Backup(r.Context(), a, id)
		case "restore-plans":
			result, e = s.Plans(r.Context(), a, query)
		case "restore-plans-item":
			result, e = s.Plan(r.Context(), a, id, query)
		case "operations-item":
			result, e = s.Operation(r.Context(), a, id)
		case "command-results-item":
			result, e = s.CommandResult(r.Context(), a, id)
		}
	}
	respond(w, result, e)
}
func (h Handler) internal(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method != "POST" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		respond(w, nil, failure("not_found", 404))
		return
	}
	if h.Native == nil || path == "/v1/internal/maintenance/authorize" && h.Service == nil {
		respond(w, nil, failure("maintenance_native_not_configured", 503))
		return
	}
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil || !includes([]string{"127.0.0.1", "::1", "::ffff:127.0.0.1"}, host) {
		respond(w, nil, failure("maintenance_service_denied", 401))
		return
	}
	proof, e := h.Native.VerifyService(r)
	if e != nil {
		respond(w, nil, e)
		return
	}
	// Authentication precedes the bounded body read; verify the original raw bytes before JSON parsing.
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		respond(w, nil, failure("unsupported_media_type", 415))
		return
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 65537))
	if e != nil || len(raw) > 65536 {
		respond(w, nil, failure("request_too_large", 413))
		return
	}
	if !utf8.Valid(raw) {
		respond(w, nil, failure("invalid_json", 400))
		return
	}
	if e = h.Native.VerifyBody(proof, raw); e != nil {
		respond(w, nil, e)
		return
	}
	var input Object
	if json.Unmarshal(raw, &input) != nil || input == nil {
		respond(w, nil, failure("invalid_json", 400))
		return
	}
	var result Object
	if path == "/v1/internal/maintenance/chat-probe" {
		if len(input) != 3 || !whole(input["version"], 1, 1) || input["kind"] != "prosody-current-state" {
			respond(w, nil, invalid())
			return
		}
		if id := input["operationId"]; id != nil && !uuidPattern.MatchString(strings.ToLower(str(id))) {
			respond(w, nil, invalid())
			return
		}
		if _, ok := input["operationId"]; !ok {
			respond(w, nil, invalid())
			return
		}
		if h.Service == nil || h.Service.ChatProbe == nil {
			respond(w, nil, failure("maintenance_prosody_live_component_readiness_unconfirmed", 503))
			return
		}
		result, e = h.Service.ChatProbe(r.Context())
		if e != nil {
			code := map[string]string{"chat_transport_unavailable": "maintenance_prosody_probe_unavailable", "chat_delivery_unknown": "maintenance_prosody_probe_timeout", "chat_transport_invalid_reply": "maintenance_prosody_probe_invalid_ack"}[fault.Code(e)]
			if code == "" {
				code = "maintenance_prosody_live_component_readiness_unconfirmed"
			}
			respond(w, nil, failure(code, 503))
			return
		}
		if result["authenticatedGateway"] != true || result["roomsDomain"] != "rooms.galaxy.internal" || result["roundTrip"] != true || result["readOnly"] != true || result["bodyReturned"] != false {
			respond(w, nil, failure("maintenance_prosody_live_component_readiness_unconfirmed", 503))
			return
		}
		result = Object{"authenticatedGateway": true, "roomsDomain": "rooms.galaxy.internal", "roundTrip": true, "readOnly": true, "bodyReturned": false}
	} else {
		result, e = h.Service.AuthorizeNative(r.Context(), input)
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, result, e)
}
