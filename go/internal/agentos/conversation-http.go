package agentos

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
)

type ConversationHandler struct {
	Service   *Conversations
	Authority operationspermissions.Authority
	Next      http.Handler
}

var conversationHTTPPath = regexp.MustCompile(`(?i)^/v1/operations/agentos/conversations/(overview|governance|messaging|discovery|maintenance)(?:/(runs|qualification|operations/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:/(events|cancel))?))?$`)
var conversationAfter = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,9})$`)
var conversationCardHTTPPath = regexp.MustCompile(`(?i)^/v1/operations/agentos/conversations/(overview|governance|messaging|discovery|maintenance)/cards/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:/(confirm|dismiss))?$`)

func conversationBody(r *http.Request, limit int64) (Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 400)
	}
	var input Object
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, fail("invalid_request", 400)
	}
	return input, nil
}

func (h ConversationHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if card := conversationCardHTTPPath.FindStringSubmatch(r.URL.EscapedPath()); card != nil {
		h.card(w, r, card)
		return
	}
	path := conversationHTTPPath.FindStringSubmatch(r.URL.EscapedPath())
	if path == nil {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("X-Request-Id", id)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	writeError := func(err error) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(fault.Status(err))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(err), "requestId": id})
	}
	domain, operation, ending := path[1], path[3], path[4]
	sending := path[2] == "runs" && r.Method == "POST"
	cancelling := ending == "cancel" && r.Method == "POST"
	observing := ending == "events" && r.Method == "GET"
	reading := ending == "" && path[2] != "runs" && r.Method == "GET"
	if !sending && !cancelling && !observing && !reading {
		writeError(fail("not_found", 404))
		return
	}
	after := int64(-1)
	if observing {
		if len(r.URL.RawQuery) > 79 {
			writeError(fail("invalid_operations_agentos_request", 400))
			return
		}
		query, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			writeError(fail("invalid_operations_agentos_request", 400))
			return
		}
		for key, values := range query {
			if key != "after" || len(values) != 1 || !conversationAfter.MatchString(values[0]) {
				err = fail("invalid_operations_agentos_request", 400)
				break
			}
			after, _ = strconv.ParseInt(values[0], 10, 64)
		}
		if err != nil {
			writeError(err)
			return
		}
	} else if r.URL.RawQuery != "" {
		code, status := "not_found", 404
		if cancelling {
			code, status = "invalid_operations_agentos_request", 400
		}
		writeError(fail(code, status))
		return
	}
	if h.Service == nil || h.Authority == nil {
		writeError(fail("operations_authorization_unavailable", 503))
		return
	}
	actor, err := h.Authority.AuthorizeOperations(r, sending || cancelling, "workbench.read")
	if err != nil {
		writeError(err)
		return
	}
	authorize := func(context.Context) (operationspermissions.Actor, error) {
		return h.Authority.AuthorizeOperations(r, sending || cancelling, "workbench.read")
	}
	if observing {
		h.stream(w, r, actor, domain, operation, after, authorize, writeError)
		return
	}
	var out Object
	switch {
	case sending, cancelling:
		limit := int64(65536)
		if cancelling {
			limit = 2048
		}
		var input Object
		input, err = conversationBody(r, limit)
		if err == nil {
			if cancelling {
				out, err = h.Service.Cancel(r.Context(), actor, domain, operation, input, authorize)
			} else {
				out, err = h.Service.Run(r.Context(), actor, domain, input, authorize)
			}
		}
	case operation != "":
		out, err = h.Service.Operation(r.Context(), actor, domain, operation)
	case path[2] == "qualification":
		out, err = h.Service.ReadQualification(r.Context(), actor, domain)
	default:
		out, err = h.Service.ReadConversation(r.Context(), actor, domain)
	}
	if err != nil {
		writeError(err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

var stopConversationObservation = errors.New("conversation observation complete")

func (h ConversationHandler) stream(w http.ResponseWriter, r *http.Request, actor operationspermissions.Actor, domain, id string, after int64, authorize AuthorizeConversation, writeError func(error)) {
	started := false
	writer := http.NewResponseController(w)
	write := func(value Object) error {
		if r.Context().Err() != nil {
			return r.Context().Err()
		}
		if !started {
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store, no-transform")
			w.Header().Set("X-Accel-Buffering", "no")
			w.WriteHeader(http.StatusOK)
			started = true
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if position, ok := index(value["eventIndex"]); ok {
			if _, err = fmt.Fprintf(w, "id: %d\n", position); err != nil {
				return err
			}
		}
		if _, err = fmt.Fprintf(w, "event: message\ndata: %s\n\n", raw); err != nil {
			return err
		}
		return writer.Flush()
	}
	err := h.Service.Events(r.Context(), actor, domain, id, after, authorize, func(value Object) error {
		projected := BrowserConversationEvent(value, id)
		if projected == nil {
			return nil
		}
		if err := write(projected); err != nil {
			return err
		}
		if projected["kind"] == "terminal" || projected["kind"] == "resync" {
			return stopConversationObservation
		}
		return nil
	})
	if err == nil || errors.Is(err, stopConversationObservation) || r.Context().Err() != nil {
		return
	}
	if !started {
		writeError(err)
		return
	}
	kind := "resync"
	if fault.Code(err) == "operations_agentos_source_changed" {
		kind = "context-changed"
	} else if fault.Status(err) == 401 || fault.Status(err) == 403 {
		kind = "blocked"
	}
	_ = write(Object{"kind": kind, "operationId": id, "eventIndex": nil})
}
