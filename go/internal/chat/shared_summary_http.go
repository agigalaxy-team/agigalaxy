package chat

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"net/http"
	"strings"
)

type SharedSummaryHandler struct {
	Service *SharedSummaryService
	Next    http.Handler
}

func (h SharedSummaryHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	prefix := "/v2/chat/shared-summaries/"
	action := strings.TrimPrefix(r.URL.Path, prefix)
	if r.Method != "POST" || !strings.HasPrefix(r.URL.Path, prefix) || !has([]string{"publish", "get", "list", "receipt", "retract"}, action) {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", id)
	result, e := h.dispatch(r, action)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		result = Object{"error": fault.Code(e), "requestId": id}
	}
	json.NewEncoder(w).Encode(result)
}
func (h SharedSummaryHandler) dispatch(r *http.Request, action string) (Object, error) {
	f := h.Service
	if f == nil || f.Chat == nil || f.Chat.Devices == nil {
		return nil, fail("shared_summary_service_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	actor, e := f.Chat.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "binding")
	if e != nil {
		return nil, e
	}
	raw, _, e := readChatBody(r)
	if e != nil {
		return nil, e
	}
	a := Actor{Device: &actor}
	ctx := r.Context()
	switch action {
	case "publish":
		return f.Publish(ctx, a, raw)
	case "get":
		return f.Get(ctx, a, raw)
	case "list":
		return f.List(ctx, a, raw)
	case "receipt":
		return f.Receipt(ctx, a, raw)
	case "retract":
		return f.Retract(ctx, a, raw)
	}
	return nil, fail("not_found", 404)
}
