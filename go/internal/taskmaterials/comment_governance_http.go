package taskmaterials

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type CommentGovernanceHandler struct {
	Service *CommentGovernance
	Next    http.Handler
}

var commentGovernancePath = regexp.MustCompile(`^/v2/comment-governance/([0-9a-f-]{36})(?:/(events))?$`)

func (h CommentGovernanceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	match := commentGovernancePath.FindStringSubmatch(r.URL.Path)
	if match == nil && r.URL.Path != "/v2/comment-governance/config" && r.URL.Path != "/v2/comment-governance/reports" && r.URL.Path != "/v2/comment-governance/query" && r.URL.Path != "/v2/comment-governance/receipt" {
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
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h CommentGovernanceHandler) dispatch(r *http.Request, id string, match []string) (any, error) {
	g := h.Service
	if g == nil || g.CommentService == nil || g.Service == nil || g.Devices == nil {
		return nil, fail("comment_governance_unavailable", 503)
	}
	reading := r.URL.Path == "/v2/comment-governance/config" || match != nil && match[2] == ""
	if reading && r.Method != "GET" || !reading && r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	current, e := g.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "moderation")
	if e != nil {
		return nil, e
	}
	actor := Actor{Actor: current, HTTPRequestID: &id}
	if reading {
		if match != nil {
			return g.Get(r.Context(), actor, match[1])
		}
		return g.Config(r.Context(), actor)
	}
	raw, e := body(r, 32768)
	if e != nil {
		return nil, e
	}
	if r.URL.Path == "/v2/comment-governance/reports" || match != nil {
		var input Envelope
		if decode(raw, &input) != nil {
			return nil, fail("invalid_request", 400)
		}
		if match != nil {
			return g.Event(r.Context(), actor, match[1], input)
		}
		return g.Report(r.Context(), actor, input)
	}
	input, e := parseObject(string(raw))
	if e != nil {
		return nil, e
	}
	if r.URL.Path == "/v2/comment-governance/query" {
		return g.Query(r.Context(), actor, input)
	}
	if !exactFields(input, []string{"operationId", "payloadHash"}, nil) {
		return nil, fail("invalid_comment_receipt", 400)
	}
	return g.Receipt(r.Context(), actor, str(input, "operationId"), str(input, "payloadHash"))
}
