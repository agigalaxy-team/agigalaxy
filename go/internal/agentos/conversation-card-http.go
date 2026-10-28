package agentos

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
)

func (h ConversationHandler) card(w http.ResponseWriter, r *http.Request, path []string) {
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Request-Id", id)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	failHTTP := func(err error) {
		w.WriteHeader(fault.Status(err))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(err), "requestId": id})
	}
	changing := path[3] != "" && r.Method == "POST"
	if r.URL.RawQuery != "" || !changing && (path[3] != "" || r.Method != "GET") {
		failHTTP(fail("not_found", 404))
		return
	}
	if h.Service == nil || h.Service.Tools == nil || h.Authority == nil {
		failHTTP(fail("operations_authorization_unavailable", 503))
		return
	}
	actor, err := h.Authority.AuthorizeOperations(r, changing, "workbench.read")
	if err != nil {
		failHTTP(err)
		return
	}
	authorize := func(context.Context) (operationspermissions.Actor, error) {
		return h.Authority.AuthorizeOperations(r, changing, "workbench.read")
	}
	var result Object
	if changing {
		input, e := conversationBody(r, 2048)
		err = e
		if err == nil {
			if path[3] == "dismiss" {
				result, err = h.Service.Tools.Dismiss(r.Context(), actor, path[1], path[2], input, authorize)
			} else {
				result, err = h.Service.Tools.Confirm(r.Context(), actor, path[1], path[2], input, authorize)
			}
		}
	} else {
		result, err = h.Service.Tools.Card(r.Context(), actor, path[1], path[2])
	}
	if err != nil {
		failHTTP(err)
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}
