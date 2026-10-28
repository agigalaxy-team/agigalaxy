package agentos

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

type NativeHandler struct {
	Conversations *Conversations
	Gateway       *ExecutionGateway
	Client        *Client
	Next          http.Handler
}

func (h NativeHandler) VerifyService(r *http.Request) error {
	if h.Client == nil || protocol.TextLength(h.Client.configuration.ServiceKey) < 32 {
		return fail("operations_agentos_service_denied", 403)
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return fail("operations_agentos_service_denied", 403)
	}
	provided := strings.TrimPrefix(values[0], "Bearer ")
	expected := h.Client.configuration.ServiceKey
	if len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
		return fail("operations_agentos_service_denied", 403)
	}
	return nil
}
func (h NativeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/internal/agentos/authorize" && r.URL.Path != "/v1/internal/agentos/tools/execute" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-Id")
	if id == "" {
		id = uuid.NewString()
		w.Header().Set("X-Request-Id", id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	value, err := h.dispatch(r)
	if err != nil {
		w.WriteHeader(fault.Status(err))
		value = Object{"error": fault.Code(err), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(value)
}
func (h NativeHandler) dispatch(r *http.Request) (Object, error) {
	if r.Method != "POST" || r.URL.RawQuery != "" {
		return nil, fail("not_found", 404)
	}
	if err := h.VerifyService(r); err != nil {
		return nil, err
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32769))
	if err != nil {
		return nil, err
	}
	if len(raw) > 32768 {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 400)
	}
	var input Object
	if protocol.Decode(raw, &input) != nil || input == nil {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	if input["executionId"] != nil {
		if h.Gateway == nil {
			return nil, fail("operations_agentos_execution_not_ready", 503)
		}
		if r.URL.Path == "/v1/internal/agentos/tools/execute" {
			return h.Gateway.Execute(r.Context(), input, nil)
		}
		return h.Gateway.AuthorizeNative(r.Context(), input)
	}
	if h.Conversations == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	if r.URL.Path == "/v1/internal/agentos/tools/execute" {
		if h.Conversations.Tools == nil {
			return nil, fail("operations_agentos_conversation_not_ready", 503)
		}
		return h.Conversations.Tools.Execute(r.Context(), input)
	}
	if input["conversationId"] == nil {
		return nil, fail("operations_agentos_execution_not_ready", 503)
	}
	return h.Conversations.AuthorizeNative(r.Context(), input)
}
