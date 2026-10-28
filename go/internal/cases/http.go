package cases

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

type DeviceIdentity interface {
	Authenticate(context.Context, string, string) (deviceauth.Actor, error)
}
type Handler struct {
	Service *Service
	Devices DeviceIdentity
	Next    http.Handler
}

var getPath = regexp.MustCompile(`^/v1/cases/([0-9a-f-]{36})$`)
var taskReceiptPath = regexp.MustCompile(`^/v2/tasks/([0-9a-f-]{36})/case-link/receipt$`)
var readPath = regexp.MustCompile(`^/v2/cases/([0-9a-f-]{36})/read$`)
var linkPath = regexp.MustCompile(`^/v2/tasks/([0-9a-f-]{36})/case$`)

func body(r *http.Request) ([]byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return nil, e
	}
	if len(raw) > 32768 {
		return nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	var o Object
	if json.Unmarshal(raw, &o) != nil || o == nil {
		return nil, fault.New("invalid_request", 400)
	}
	return raw, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	matched := r.Method == "POST" && (path == "/v1/cases" || path == "/v1/case-events" || path == "/v2/cases/events/receipt" || path == "/v2/cases/events" || path == "/v2/cases/intervention-responses" || readPath.MatchString(path) || taskReceiptPath.MatchString(path) || linkPath.MatchString(path)) || r.Method == "GET" && getPath.MatchString(path)
	if !matched {
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
	out, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": id})
		return
	}
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, id string) (Object, error) {
	if h.Service == nil {
		return nil, fault.New("case_service_unavailable", 503)
	}
	header := r.Header.Get("Authorization")
	if h.Devices == nil || !strings.HasPrefix(header, "Bearer ") {
		return nil, fault.New("access_denied", 401)
	}
	a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "case-teaser")
	if e != nil {
		return nil, e
	}
	if match := getPath.FindStringSubmatch(r.URL.Path); match != nil {
		return h.Service.Get(r.Context(), a, match[1])
	}
	raw, e := body(r)
	if e != nil {
		return nil, e
	}
	if r.URL.Path == "/v2/cases/events/receipt" {
		return h.Service.Receipt(r.Context(), a, raw)
	}
	if r.URL.Path == "/v2/cases/events" {
		return h.Service.SubmitV2(r.Context(), a, raw, id)
	}
	if r.URL.Path == "/v2/cases/intervention-responses" {
		return h.Service.RespondBatch(r.Context(), a, raw, id)
	}
	if match := readPath.FindStringSubmatch(r.URL.Path); match != nil {
		return h.Service.GetV2(r.Context(), a, match[1], raw)
	}
	if match := linkPath.FindStringSubmatch(r.URL.Path); match != nil {
		var input Object
		_ = json.Unmarshal(raw, &input)
		input["taskId"] = match[1]
		return h.Service.CreateAndLinkTask(r.Context(), a, encode(input), id)
	}
	if match := taskReceiptPath.FindStringSubmatch(r.URL.Path); match != nil {
		var q Object
		if json.Unmarshal(raw, &q) != nil || !shape(q, []string{"operationId", "payloadHash"}, nil) {
			return nil, fault.New("invalid_request", 400)
		}
		q["taskId"] = match[1]
		return h.Service.TaskLinkReceipt(r.Context(), a, encode(q))
	}
	_, payload, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	var p Object
	if json.Unmarshal([]byte(payload), &p) != nil {
		return nil, fault.New("invalid_case_payload", 400)
	}
	if (r.URL.Path == "/v1/cases") != (p["kind"] == "case") {
		return nil, fault.New("invalid_case_route", 400)
	}
	return h.Service.Submit(r.Context(), a, raw, id)
}
