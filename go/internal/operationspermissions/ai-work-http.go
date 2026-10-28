package operationspermissions

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/google/uuid"
)

type AIWorkHandler struct {
	Service *Service
	Next    http.Handler
}

func (h AIWorkHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	root := "/v1/operations/ai-work-accounts"
	path := r.URL.EscapedPath()
	if path != root && !strings.HasPrefix(path, root+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-ID")
	if id == "" {
		id = uuid.NewString()
		w.Header().Set("X-Request-ID", id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	out, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": id})
		return
	}
	json.NewEncoder(w).Encode(out)
}
func (h AIWorkHandler) dispatch(r *http.Request, requestID string) (Object, error) {
	part := strings.TrimPrefix(r.URL.EscapedPath(), "/v1/operations/ai-work-accounts")
	segments := []string{}
	if part != "" {
		if !strings.HasPrefix(part, "/") {
			return nil, fail("not_found", 404)
		}
		segments = strings.Split(part[1:], "/")
	}
	domain, method, id := "", "", ""
	if r.Method == "GET" {
		if len(segments) == 0 {
			method = "list"
		} else if len(segments) == 2 && segments[0] == "operations" && routeID.MatchString("operations/"+segments[1]) {
			method, id = "operation", segments[1]
		} else if (len(segments) == 1 || len(segments) == 2) && contains(operationsai.Domains, segments[0]) {
			domain = segments[0]
			method = "detail"
			if len(segments) == 2 {
				if segments[1] != "history" && segments[1] != "runtime" {
					return nil, fail("not_found", 404)
				}
				method = segments[1]
			}
		}
	} else if r.Method == "POST" && len(segments) == 2 && contains(operationsai.Domains, segments[0]) && (segments[1] == "commands" || segments[1] == "assignments") {
		domain, method = segments[0], segments[1]
	}
	if method == "" || r.URL.RawQuery != "" && method != "history" {
		return nil, fail("not_found", 404)
	}
	s := h.Service
	if s == nil || s.Authority == nil {
		return nil, fail("operations_ai_work_unavailable", 503)
	}
	write := r.Method == "POST"
	actor, e := s.Authority.AuthorizeOperations(r, write, "ai.accounts.read")
	if e != nil {
		return nil, e
	}
	actor.RequestID = &requestID
	input := Object{}
	if write {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			return nil, fail("unsupported_media_type", 415)
		}
		raw, e := io.ReadAll(io.LimitReader(r.Body, 8193))
		if e != nil {
			return nil, e
		}
		if len(raw) > 8192 {
			return nil, fail("request_too_large", 413)
		}
		if !utf8.Valid(raw) || !json.Valid(raw) {
			return nil, fail("invalid_json", 400)
		}
		if json.Unmarshal(raw, &input) != nil || input == nil {
			return nil, fail("invalid_request", 400)
		}
	} else if method == "history" {
		if len(r.URL.RawQuery)+1 > 1024 {
			return nil, aiInvalid()
		}
		for k, v := range r.URL.Query() {
			if !contains([]string{"after", "limit"}, k) || len(v) != 1 {
				return nil, aiInvalid()
			}
			if k == "limit" {
				n, e := javascriptNumber(v[0])
				if e != nil {
					return nil, aiInvalid()
				}
				input[k] = n
			} else {
				input[k] = v[0]
			}
		}
	}
	switch method {
	case "list":
		return s.AIWorkList(r.Context(), actor)
	case "detail":
		return s.AIWorkDetail(r.Context(), actor, domain)
	case "operation":
		return s.AIWorkOperation(r.Context(), actor, id)
	case "history":
		return s.AIWorkHistory(r.Context(), actor, domain, input)
	case "runtime":
		return s.AIWorkRuntime(r.Context(), actor, domain)
	case "commands":
		return s.AIWorkCommand(r.Context(), actor, domain, input)
	case "assignments":
		return s.AIWorkAssignment(r.Context(), actor, domain, input)
	}
	return nil, fail("not_found", 404)
}
