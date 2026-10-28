package taskmaterials

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/google/uuid"
)

type CommentHandler struct {
	Service *CommentService
	Next    http.Handler
}

var commentPath = regexp.MustCompile(`^/v2/comments/([0-9a-f-]{36})$`)

func (h CommentHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	match := commentPath.FindStringSubmatch(r.URL.Path)
	if match == nil && r.URL.Path != "/v2/comments" && r.URL.Path != "/v2/comments/query" && r.URL.Path != "/v2/comments/receipt" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", id)
	out, e := h.dispatch(r, id, match)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
		for key, value := range publicwrites.Details(e) {
			out.(map[string]any)[key] = value
		}
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h CommentHandler) dispatch(r *http.Request, id string, match []string) (any, error) {
	c := h.Service
	if c == nil || c.Service == nil || c.Devices == nil {
		return nil, fail("comment_service_unavailable", 503)
	}
	reading := match != nil || r.URL.Path == "/v2/comments/query"
	if match != nil && r.Method != "GET" || match == nil && r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	var actor *Actor
	if values, present := r.Header["Authorization"]; present {
		if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
			return nil, fail("access_denied", 401)
		}
		current, e := c.Devices.Authenticate(r.Context(), strings.TrimPrefix(values[0], "Bearer "), "assistance")
		if e != nil {
			return nil, e
		}
		actor = &Actor{Actor: current, HTTPRequestID: &id}
	}
	if actor == nil && !reading {
		return nil, fail("access_denied", 401)
	}
	if match != nil {
		return c.Get(r.Context(), actor, match[1])
	}
	raw, e := body(r, 32768)
	if e != nil {
		return nil, e
	}
	if r.URL.Path == "/v2/comments/query" {
		input, e := parseObject(string(raw))
		if e != nil {
			return nil, e
		}
		return c.Query(r.Context(), actor, input)
	}
	if r.URL.Path == "/v2/comments/receipt" {
		input, e := parseObject(string(raw))
		if e != nil || !exactFields(input, []string{"operationId", "payloadHash"}, nil) {
			return nil, fail("invalid_comment_receipt", 400)
		}
		return c.Receipt(r.Context(), *actor, str(input, "operationId"), str(input, "payloadHash"))
	}
	var input Envelope
	if decode(raw, &input) != nil {
		return nil, fail("invalid_request", 400)
	}
	return c.Submit(r.Context(), *actor, input)
}
