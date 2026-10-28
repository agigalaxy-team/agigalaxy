package operationsautonomy

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"net/http"
	"unicode/utf8"
)

type PrivateHandler struct {
	Service       *Service
	VerifyService func(*http.Request) error
	Next          http.Handler
}

func respond(w http.ResponseWriter, out any, e error) {
	w.Header().Set("Content-Type", "application/json")
	if e != nil {
		w.WriteHeader(fault.Status(e))
		json.NewEncoder(w).Encode(Object{"error": fault.Code(e)})
		return
	}
	json.NewEncoder(w).Encode(out)
}
func (h PrivateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method := map[string]string{"/v1/internal/agentos/autonomy/authorize": "authorize", "/v1/internal/agentos/autonomy/report": "report", "/v1/internal/agentos/autonomy/tools/execute": "tool", "/v1/internal/agentos/autonomy/code": "code"}[r.URL.EscapedPath()]
	if method == "" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			respond(w, nil, fault.New("not_found", 404))
		}
		return
	}
	if r.Method != "POST" || r.URL.RawQuery != "" {
		respond(w, nil, fault.New("not_found", 404))
		return
	}
	if h.Service == nil || h.VerifyService == nil {
		respond(w, nil, fault.New("operations_autonomy_unavailable", 503))
		return
	}
	if e := h.VerifyService(r); e != nil {
		respond(w, nil, e)
		return
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		respond(w, nil, fault.New("unsupported_media_type", 415))
		return
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 65537))
	if e != nil || len(b) > 65536 {
		respond(w, nil, fault.New("request_too_large", 413))
		return
	}
	if !utf8.Valid(b) || !json.Valid(b) {
		respond(w, nil, fault.New("invalid_json", 400))
		return
	}
	var input Object
	if json.Unmarshal(b, &input) != nil || input == nil {
		respond(w, nil, fault.New("invalid_request", 400))
		return
	}
	var out Object
	switch method {
	case "authorize":
		out, e = h.Service.Authorize(r.Context(), input)
	case "report":
		out, e = h.Service.Report(r.Context(), input)
	case "tool":
		out, e = h.Service.Tool(r.Context(), input, false)
	case "code":
		out, e = h.Service.RunCodeTask(r.Context(), input)
	}
	respond(w, out, e)
}
