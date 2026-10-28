package operationsstrategies

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

type Handler struct {
	Service       *Service
	Next          http.Handler
	VerifyService func(*http.Request) error
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

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const root = "/v1/operations/strategies"
	path := r.URL.EscapedPath()
	if path == "/v1/internal/agentos/p13/context" || path == "/v1/internal/agentos/p13/step" {
		if r.Method != "POST" || r.URL.RawQuery != "" || r.URL.ForceQuery {
			respond(w, nil, fail("not_found", 404))
			return
		}
		if h.Service == nil || h.VerifyService == nil {
			respond(w, nil, fail("p13_not_configured", 503))
			return
		}
		if e := h.VerifyService(r); e != nil {
			respond(w, nil, e)
			return
		}
		input, _, e := requestBody(r, 4096)
		if e != nil {
			respond(w, nil, e)
			return
		}
		var out Object
		if path == "/v1/internal/agentos/p13/context" {
			out, e = h.Service.NativeContext(r.Context(), input)
		} else {
			out, e = h.Service.Step(r.Context(), input)
		}
		respond(w, out, e)
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
	read, write := r.Method == "GET", r.Method == "POST"
	pieces := strings.Split(part, "/")
	kind, id, action := "", "", "strategies.read"
	if read {
		if has([]string{"overview", "options", "versions", "records"}, part) {
			kind = part
		} else if len(pieces) == 2 && has([]string{"runs", "operations"}, pieces[0]) && uuidPattern.MatchString(pieces[1]) {
			kind, id = pieces[0], pieces[1]
		}
	} else if write {
		if has([]string{"draft", "publish", "control", "rehearsal", "runs"}, part) {
			kind = part
			action = map[string]string{"draft": "strategies.configure", "publish": "strategies.publish", "control": "strategies.control", "rehearsal": "strategies.read", "runs": "strategies.run"}[part]
		} else if len(pieces) == 3 && pieces[0] == "runs" && uuidPattern.MatchString(pieces[1]) && pieces[2] == "continue" {
			kind, id, action = "continue", pieces[1], "strategies.run"
		}
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		respond(w, nil, fail("p13_not_configured", 503))
		return
	}
	if kind == "" {
		respond(w, nil, fail("not_found", 404))
		return
	}
	a, e := s.Authority.AuthorizeOperations(r, write, action)
	if e != nil {
		respond(w, nil, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	keys := []string{}
	if kind == "versions" {
		keys = []string{"after", "limit"}
	} else if kind == "records" {
		keys = []string{"after", "limit", "strategyId"}
	} else if r.URL.RawQuery != "" || r.URL.ForceQuery {
		respond(w, nil, invalid())
		return
	}
	query, e := requestQuery(r, keys)
	if e != nil {
		respond(w, nil, e)
		return
	}
	var out Object
	if read {
		switch kind {
		case "overview":
			out, e = s.Get(r.Context(), a)
		case "options":
			out, e = s.Options(r.Context(), a)
		case "versions":
			out, e = s.Versions(r.Context(), a, query)
		case "records":
			out, e = s.Records(r.Context(), a, query)
		case "operations":
			out, e = s.Operation(r.Context(), a, id)
		case "runs":
			out, e = s.RunDetail(r.Context(), a, id)
		}
	} else {
		max := int64(32768)
		if kind == "draft" {
			max = 262144
		}
		input, _, err := requestBody(r, max)
		if err != nil {
			respond(w, nil, err)
			return
		}
		authorize := func() (Actor, error) { return s.Authority.AuthorizeOperations(r, true, "") }
		switch kind {
		case "draft":
			out, e = s.SaveDraft(r.Context(), a, input, authorize)
		case "publish":
			out, e = s.Publish(r.Context(), a, input, authorize)
		case "control":
			out, e = s.Control(r.Context(), a, input, authorize)
		case "rehearsal":
			out, e = s.Rehearsal(r.Context(), a, input)
		case "runs":
			out, e = s.Run(r.Context(), a, input, authorize)
		case "continue":
			out, e = s.Continue(r.Context(), a, id, input, authorize)
		}
	}
	respond(w, out, e)
}
