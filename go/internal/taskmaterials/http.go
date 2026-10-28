package taskmaterials

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/google/uuid"
)

type Handler struct {
	Task    *Service
	Outcome *OutcomeService
	Next    http.Handler
}

var statusPath = regexp.MustCompile(`^/v2/tasks/([0-9a-f-]{36})/materials/status$`)
var taskPath = regexp.MustCompile(`^/v2/tasks/([0-9a-f-]{36})$`)
var taskEventPath = regexp.MustCompile(`^/v2/tasks/([0-9a-f-]{36})/(events|participations)$`)
var participationEventPath = regexp.MustCompile(`^/v2/participations/([0-9a-f-]{36})/events$`)
var taskOwnerPath = regexp.MustCompile(`^/v2/tasks/([0-9a-f-]{36})/(owner-read|owner-control)(?:/(prepare))?$`)
var outcomePath = regexp.MustCompile(`^/v2/outcome-materials/(request|approve|control|read|query|source|inspect|receipt)$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if legacyRoute(r.URL.Path) {
		LegacyHandler{Service: h.Task}.ServeHTTP(w, r)
		return
	}
	if r.URL.Path != "/v2/tasks" && r.URL.Path != "/v2/tasks/query" && r.URL.Path != "/v2/tasks/receipt" && taskPath.FindStringSubmatch(r.URL.Path) == nil && taskEventPath.FindStringSubmatch(r.URL.Path) == nil && participationEventPath.FindStringSubmatch(r.URL.Path) == nil && taskOwnerPath.FindStringSubmatch(r.URL.Path) == nil && r.URL.Path != "/v2/task-materials/prepare" && statusPath.FindStringSubmatch(r.URL.Path) == nil && outcomePath.FindStringSubmatch(r.URL.Path) == nil {
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
	out, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		body := Object{"error": fault.Code(e), "requestId": id}
		for k, v := range publicwrites.Details(e) {
			body[k] = v
		}
		out = body
	}
	_ = json.NewEncoder(w).Encode(out)
}
func body(r *http.Request, maximum int) ([]byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, int64(maximum)+1))
	if e != nil {
		return nil, e
	}
	if len(raw) > maximum {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 400)
	}
	var value Object
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, fail("invalid_request", 400)
	}
	return raw, nil
}
func nullInput(value any) bool {
	switch x := value.(type) {
	case nil:
		return true
	case map[string]any:
		for _, v := range x {
			if nullInput(v) {
				return true
			}
		}
	case []any:
		for _, v := range x {
			if nullInput(v) {
				return true
			}
		}
	}
	return false
}
func decode(raw []byte, out any) error {
	var tree any
	_ = json.Unmarshal(raw, &tree)
	if nullInput(tree) || protocol.Decode(raw, out) != nil {
		return fail("invalid_request", 400)
	}
	return nil
}
func (h Handler) dispatch(r *http.Request, id string) (any, error) {
	if r.URL.Path == "/v2/tasks" || r.URL.Path == "/v2/tasks/query" || r.URL.Path == "/v2/tasks/receipt" || taskPath.FindStringSubmatch(r.URL.Path) != nil || taskEventPath.FindStringSubmatch(r.URL.Path) != nil || participationEventPath.FindStringSubmatch(r.URL.Path) != nil || taskOwnerPath.FindStringSubmatch(r.URL.Path) != nil {
		return h.taskDispatch(r, id)
	}
	s := h.Task
	scope := "assistance"
	match := outcomePath.FindStringSubmatch(r.URL.Path)
	if match != nil {
		if h.Outcome == nil {
			return nil, fail("outcome_material_service_unavailable", 503)
		}
		s = h.Outcome.Service
		scope = "evidence"
	}
	if s == nil || s.Devices == nil {
		return nil, fail("material_service_unavailable", 503)
	}
	status := statusPath.FindStringSubmatch(r.URL.Path)
	if status != nil {
		if r.Method != "GET" {
			return nil, fail("not_found", 404)
		}
	} else if r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fail("access_denied", 401)
	}
	current, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), scope)
	if e != nil {
		return nil, e
	}
	actor := Actor{Actor: current, HTTPRequestID: &id}
	if status != nil {
		return s.Status(r.Context(), actor, status[1])
	}
	maximum := 32768
	if r.URL.Path == "/v2/task-materials/prepare" {
		maximum = 100000
	}
	raw, e := body(r, maximum)
	if e != nil {
		return nil, e
	}
	if match == nil {
		input, err := ParsePrepare(raw)
		if err != nil {
			return nil, fail("invalid_task_material_request", 400)
		}
		return s.Prepare(r.Context(), actor, input)
	}
	o := h.Outcome
	switch match[1] {
	case "request", "approve", "control":
		// The original outer outcome envelope ignores unrelated keys; the signed
		// payload has its separate exact schema and preserved commitment bytes.
		var input Envelope
		if json.Unmarshal(raw, &input) != nil {
			return nil, fail("invalid_outcome_material_request", 400)
		}
		if match[1] == "request" {
			return o.Request(r.Context(), actor, input)
		}
		if match[1] == "approve" {
			return o.Approve(r.Context(), actor, input)
		}
		return o.Control(r.Context(), actor, input)
	case "read", "inspect":
		input := struct {
			ID      string `json:"id"`
			Version int    `json:"version"`
		}{Version: 1}
		if decode(raw, &input) != nil || input.Version != 1 {
			return nil, fail("invalid_outcome_material_request", 400)
		}
		if match[1] == "read" {
			return o.Read(r.Context(), actor, input.ID)
		}
		return o.Inspect(r.Context(), actor, input.ID)
	case "source":
		input := struct {
			Kind    string `json:"kind"`
			ID      string `json:"id"`
			Version int64  `json:"version"`
		}{Version: 1}
		if decode(raw, &input) != nil || input.Version < 1 {
			return nil, fail("invalid_outcome_material_request", 400)
		}
		return o.Source(r.Context(), actor, input.Kind, input.ID, input.Version)
	case "query":
		input := struct {
			View  string  `json:"view"`
			After *string `json:"after"`
			Limit int     `json:"limit"`
		}{View: "requested", Limit: 20}
		if decode(raw, &input) != nil || input.Limit < 1 || input.After != nil && !validID(*input.After) {
			return nil, fail("invalid_outcome_material_request", 400)
		}
		after := ""
		if input.After != nil {
			after = *input.After
		}
		return o.Query(r.Context(), actor, input.View, after, input.Limit)
	case "receipt":
		var input struct {
			OperationID string `json:"operationId"`
			PayloadHash string `json:"payloadHash"`
		}
		if decode(raw, &input) != nil {
			return nil, fail("invalid_outcome_material_request", 400)
		}
		return o.Receipt(r.Context(), actor, input.OperationID, input.PayloadHash)
	}
	return nil, fail("not_found", 404)
}

func (h Handler) taskDispatch(r *http.Request, id string) (any, error) {
	s := h.Task
	if s == nil || s.Devices == nil {
		return nil, fail("task_service_unavailable", 503)
	}
	read := taskPath.FindStringSubmatch(r.URL.Path)
	if read != nil && r.Method != "GET" || read == nil && r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	var a *Actor
	auth, provided := r.Header["Authorization"]
	if provided {
		if len(auth) != 1 || !strings.HasPrefix(auth[0], "Bearer ") {
			return nil, fail("access_denied", 401)
		}
		actor, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth[0], "Bearer "), "assistance")
		if e != nil {
			return nil, e
		}
		a = &Actor{Actor: actor, HTTPRequestID: &id}
	}
	if read != nil {
		return s.GetTask(r.Context(), a, read[1])
	}
	if r.URL.Path != "/v2/tasks/query" && a == nil {
		return nil, fail("access_denied", 401)
	}
	max := 32768
	if r.URL.Path == "/v2/tasks" {
		max = 100000
	}
	raw, e := body(r, max)
	if e != nil {
		return nil, e
	}
	if own := taskOwnerPath.FindStringSubmatch(r.URL.Path); own != nil {
		if own[3] == "prepare" {
			input, e := parseObject(string(raw))
			if e != nil {
				return nil, e
			}
			if _, provided := input["taskId"]; provided {
				return nil, fail("invalid_task_"+strings.ReplaceAll(own[2], "-", "_"), 400)
			}
			input["taskId"] = own[1]
			if own[2] == "owner-read" {
				return s.OwnerReadPrepare(r.Context(), *a, input)
			}
			return s.OwnerControlPrepare(r.Context(), *a, input)
		}
		var input Envelope
		if decode(raw, &input) != nil {
			return nil, fail("invalid_request", 400)
		}
		if own[2] == "owner-read" {
			return s.OwnerRead(r.Context(), *a, own[1], input)
		}
		return s.OwnerControl(r.Context(), *a, own[1], input)
	}
	if event := taskEventPath.FindStringSubmatch(r.URL.Path); event != nil {
		var input Envelope
		if json.Unmarshal(raw, &input) != nil {
			return nil, fail("invalid_task_payload")
		}
		if event[2] == "participations" {
			return s.ProposeParticipation(r.Context(), *a, event[1], input)
		}
		return s.SubmitTaskEvent(r.Context(), *a, event[1], input)
	}
	if event := participationEventPath.FindStringSubmatch(r.URL.Path); event != nil {
		var input Envelope
		if decode(raw, &input) != nil {
			return nil, fail("invalid_request", 400)
		}
		return s.SubmitParticipationEvent(r.Context(), *a, event[1], input)
	}
	switch r.URL.Path {
	case "/v2/tasks":
		var input TaskSubmission
		if decode(raw, &input) != nil {
			return nil, fail("invalid_request", 400)
		}
		if input.SignedIntent == nil {
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(raw, &fields)
			if len(raw) > 32768 {
				return nil, fail("request_too_large", 413)
			}
			if len(fields) != 2 || fields["consentId"] == nil || fields["payloadJson"] == nil {
				return nil, fail("invalid_request", 400)
			}
		}
		return s.CreateTask(r.Context(), *a, input)
	case "/v2/tasks/receipt":
		var input struct {
			TaskID      string `json:"taskId"`
			EventID     string `json:"eventId"`
			PayloadHash string `json:"payloadHash"`
		}
		if decode(raw, &input) != nil {
			return nil, fail("invalid_task_receipt", 400)
		}
		return s.TaskReceipt(r.Context(), *a, input.TaskID, input.EventID, input.PayloadHash)
	case "/v2/tasks/query":
		input := struct {
			View  string  `json:"view"`
			Query string  `json:"query"`
			After *string `json:"after"`
			Limit int     `json:"limit"`
		}{View: "open", Limit: 12}
		if decode(raw, &input) != nil || input.Limit < 1 || input.After != nil && !validID(*input.After) {
			return nil, fail("invalid_task_query", 400)
		}
		after := ""
		if input.After != nil {
			after = *input.After
		}
		return s.QueryTasks(r.Context(), a, input.View, input.Query, after, input.Limit)
	}
	return nil, fail("not_found", 404)
}
