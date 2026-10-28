package messaging

import (
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Handler struct {
	Service   *Service
	SMTP      *SMTPService
	Authority operationspermissions.Authority
	Accounts  accounts.HTTPIdentity
	Next      http.Handler
}

var planRoute = regexp.MustCompile(`(?i)^/v1/operations/messaging/plans/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:/(save|activate|pause|resume|stop|withdraw|history))?$`)
var runRoute = regexp.MustCompile(`(?i)^/v1/operations/messaging/runs/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:/(recipients|retry))?$`)
var messageOperationRoute = regexp.MustCompile(`(?i)^/v1/operations/messaging/operations/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
var announcementRoute = regexp.MustCompile(`(?i)^/v1/announcements/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
var noticeRoute = regexp.MustCompile(`^/v1/operations/notices/([0-9a-f-]{36})(?:/(save|publish|withdraw))?$`)
var noticeOperationRoute = regexp.MustCompile(`^/v1/operations/notices/operations/([0-9a-f-]{36})$`)
var accountNoticeReadRoute = regexp.MustCompile(`^/v1/account/notifications/notices/([0-9a-f-]{36})/read$`)

func (h Handler) owns(path string) bool {
	return path == "/v1/announcements" || announcementRoute.MatchString(path) || strings.HasPrefix(path, "/v1/operations/messaging/") || path == "/v1/operations/smtp" || strings.HasPrefix(path, "/v1/operations/smtp/") || path == "/v1/operations/notices" || strings.HasPrefix(path, "/v1/operations/notices/") || path == "/v1/account/notifications/notices" || strings.HasPrefix(path, "/v1/account/notifications/notices/")
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.owns(r.URL.EscapedPath()) {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-Id")
	if !uuidOK(id) {
		id = uuid.NewString()
		w.Header().Set("X-Request-Id", id)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	out, e := h.dispatch(r, id)
	if e != nil {
		status := 500
		var known *fault.Error
		if errors.As(e, &known) {
			status = known.Status
		}
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": id})
		return
	}
	json.NewEncoder(w).Encode(out)
}
func query(r *http.Request, code string, allowed ...string) (Object, error) {
	if len(r.URL.RawQuery) > 8191 {
		return nil, failure(code, 400)
	}
	values, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, failure(code, 400)
	}
	out := Object{}
	for key, list := range values {
		if !contains(allowed, key) || len(list) != 1 {
			return nil, failure(code, 400)
		}
		switch key {
		case "limit":
			out[key], e = jsNumber(list[0])
			if e != nil {
				return nil, failure(code, 400)
			}
		case "unreadOnly":
			if list[0] != "true" && list[0] != "false" {
				return nil, failure(code, 400)
			}
			out[key] = list[0] == "true"
		default:
			out[key] = list[0]
		}
	}
	return out, nil
}
func jsonBody(r *http.Request, max int) (Object, error) {
	if len(r.Header.Values("Content-Type")) != 1 || r.Header.Get("Content-Type") != "application/json" || len(r.Header.Values("Content-Encoding")) > 1 || r.Header.Get("Content-Encoding") != "" {
		return nil, failure("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, int64(max)+1))
	if e != nil {
		return nil, failure("invalid_json", 400)
	}
	if len(raw) > max {
		return nil, failure("request_too_large", 413)
	}
	if !utf8.Valid(raw) {
		return nil, failure("invalid_json", 400)
	}
	var value any
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	if d.Decode(&value) != nil || d.Decode(new(any)) != io.EOF {
		return nil, failure("invalid_json", 400)
	}
	out := obj(value)
	if out == nil {
		return nil, failure("invalid_request", 400)
	}
	return out, nil
}
func (h Handler) actor(r *http.Request, id, permission string) (Actor, error) {
	authority := h.Authority
	if authority == nil && h.Service != nil {
		authority = h.Service.Authority
	}
	if authority == nil && h.SMTP != nil {
		authority = h.SMTP.Authority
	}
	if authority == nil {
		return Actor{}, failure("operations_authorization_unavailable", 503)
	}
	a, e := authority.AuthorizeOperations(r, r.Method == "POST", permission)
	if e == nil {
		a.RequestID = &id
	}
	return a, e
}
func (h Handler) dispatch(r *http.Request, id string) (Object, error) {
	path := r.URL.EscapedPath()
	if strings.HasPrefix(path, "/v1/operations/smtp") {
		return h.dispatchSMTP(r, id)
	}
	if strings.HasPrefix(path, "/v1/operations/notices") || strings.HasPrefix(path, "/v1/account/notifications/notices") {
		return h.dispatchNotices(r, id)
	}
	s := h.Service
	if s == nil {
		return nil, failure("operations_messaging_unavailable", 503)
	}
	if path == "/v1/announcements" {
		if r.Method != "GET" {
			return nil, failure("not_found", 404)
		}
		q, e := query(r, "invalid_operations_messaging_request", "after", "limit")
		if e != nil {
			return nil, e
		}
		return s.Announcements(r.Context(), q)
	}
	if match := announcementRoute.FindStringSubmatch(path); match != nil {
		if r.Method != "GET" || r.URL.RawQuery != "" {
			return nil, failure("not_found", 404)
		}
		return s.Announcement(r.Context(), match[1])
	}
	if match := messageOperationRoute.FindStringSubmatch(path); match != nil {
		if r.Method != "GET" || r.URL.RawQuery != "" {
			return nil, failure("not_found", 404)
		}
		a, e := h.actor(r, id, "notices.read")
		if e != nil {
			return nil, e
		}
		return s.CommandResult(r.Context(), a, match[1])
	}
	plan, run := planRoute.FindStringSubmatch(path), runRoute.FindStringSubmatch(path)
	plans, runs := path == "/v1/operations/messaging/plans", path == "/v1/operations/messaging/runs"
	write := r.Method == "POST"
	if r.Method != "GET" && !write || !plans && !runs && plan == nil && run == nil {
		return nil, failure("not_found", 404)
	}
	if write {
		if r.URL.RawQuery != "" || runs || plan != nil && (plan[2] == "" || plan[2] == "history") || run != nil && run[2] != "retry" {
			return nil, failure("not_found", 404)
		}
		kind := "create"
		if plan != nil {
			kind = plan[2]
		} else if run != nil {
			kind = "retry"
		}
		a, e := h.actor(r, id, permissions[kind])
		if e != nil {
			return nil, e
		}
		input, e := jsonBody(r, 65536)
		if e != nil {
			return nil, e
		}
		switch {
		case plans:
			return s.Create(r.Context(), a, input)
		case run != nil:
			return s.Retry(r.Context(), a, run[1], input)
		case kind == "save":
			return s.Save(r.Context(), a, plan[1], input)
		default:
			return s.Action(r.Context(), a, plan[1], kind, input)
		}
	}
	if plan != nil && plan[2] != "" && plan[2] != "history" || run != nil && run[2] == "retry" {
		return nil, failure("not_found", 404)
	}
	a, e := h.actor(r, id, "notices.read")
	if e != nil {
		return nil, e
	}
	switch {
	case plans:
		q, e := query(r, "invalid_operations_messaging_request", "after", "limit", "state")
		if e != nil {
			return nil, e
		}
		return s.List(r.Context(), a, q)
	case runs:
		q, e := query(r, "invalid_operations_messaging_request", "after", "limit", "planId")
		if e != nil {
			return nil, e
		}
		return s.Runs(r.Context(), a, q)
	case plan != nil && plan[2] == "history":
		q, e := query(r, "invalid_operations_messaging_request", "after", "limit")
		if e != nil {
			return nil, e
		}
		return s.History(r.Context(), a, plan[1], q)
	case run != nil && run[2] == "recipients":
		q, e := query(r, "invalid_operations_messaging_request", "after", "limit", "channel", "state")
		if e != nil {
			return nil, e
		}
		return s.Recipients(r.Context(), a, run[1], q)
	default:
		if r.URL.RawQuery != "" {
			return nil, failure("not_found", 404)
		}
		if plan != nil {
			return s.Get(r.Context(), a, plan[1])
		}
		return s.Run(r.Context(), a, run[1])
	}
}
func (h Handler) dispatchSMTP(r *http.Request, id string) (Object, error) {
	part := strings.TrimPrefix(r.URL.EscapedPath(), "/v1/operations/smtp")
	part = strings.TrimPrefix(part, "/")
	write := r.Method == "POST"
	permission := "smtp.read"
	if write {
		permission = map[string]string{"settings": "smtp.configure", "tests/connection": "smtp.test.connection", "tests/delivery": "smtp.test.delivery"}[part]
		if permission == "" || r.URL.RawQuery != "" {
			return nil, failure("not_found", 404)
		}
	} else if r.Method != "GET" {
		return nil, failure("not_found", 404)
	}
	if !write && !contains([]string{"", "identities", "queue", "bounces", "domains", "tests", "history"}, part) && !(strings.HasPrefix(part, "operations/") && uuidOK(strings.TrimPrefix(part, "operations/"))) {
		return nil, failure("not_found", 404)
	}
	if h.SMTP == nil {
		return nil, failure("operations_authorization_unavailable", 503)
	}
	a, e := h.actor(r, id, permission)
	if e != nil {
		return nil, e
	}
	if write {
		input, e := jsonBody(r, 16384)
		if e != nil {
			return nil, e
		}
		if part == "settings" {
			return h.SMTP.Save(r.Context(), a, input)
		}
		return h.SMTP.Test(r.Context(), a, strings.TrimPrefix(part, "tests/"), input)
	}
	if strings.HasPrefix(part, "operations/") {
		operation := strings.TrimPrefix(part, "operations/")
		if !uuidOK(operation) || r.URL.RawQuery != "" {
			return nil, failure("not_found", 404)
		}
		return h.SMTP.CommandResult(r.Context(), a, operation)
	}
	paged := contains([]string{"queue", "tests", "history"}, part)
	if !paged && r.URL.RawQuery != "" {
		return nil, failure("invalid_smtp_request", 400)
	}
	q := Object{}
	if paged {
		q, e = query(r, "invalid_smtp_request", "after", "limit")
		if e != nil {
			return nil, e
		}
	}
	switch part {
	case "", "identities":
		return h.SMTP.Get(r.Context(), a)
	case "queue":
		return h.SMTP.Queue(r.Context(), a, q)
	case "tests":
		return h.SMTP.Tests(r.Context(), a, q)
	case "history":
		return h.SMTP.History(r.Context(), a, q)
	case "bounces":
		return h.SMTP.Bounces(r.Context(), a)
	case "domains":
		return h.SMTP.Domains(r.Context(), a)
	}
	return nil, failure("not_found", 404)
}
func (h Handler) dispatchNotices(r *http.Request, id string) (Object, error) {
	path := r.URL.EscapedPath()
	s := h.Service
	if s == nil {
		return nil, failure("operations_notices_unavailable", 503)
	}
	if strings.HasPrefix(path, "/v1/account/") {
		list := path == "/v1/account/notifications/notices"
		match := accountNoticeReadRoute.FindStringSubmatch(path)
		if !list && match == nil || list && r.Method != "GET" || match != nil && r.Method != "POST" {
			return nil, failure("not_found", 404)
		}
		if h.Accounts == nil {
			return nil, failure("operations_notices_unavailable", 503)
		}
		account, authorization, e := h.Accounts.Account(r, !list)
		if e != nil {
			return nil, e
		}
		if list {
			q, e := query(r, "invalid_operations_product_request", "after", "limit", "unreadOnly")
			if e != nil {
				return nil, e
			}
			return s.NoticeAccountQuery(r.Context(), account, authorization, q)
		}
		if r.URL.RawQuery != "" {
			return nil, productInvalid()
		}
		input, e := jsonBody(r, 32768)
		if e != nil {
			return nil, e
		}
		if len(input) != 0 {
			return nil, failure("invalid_request", 400)
		}
		return s.NoticeAccountMarkRead(r.Context(), account, authorization, Object{"noticeId": match[1]})
	}
	write := r.Method == "POST"
	if r.Method != "GET" && !write {
		return nil, failure("not_found", 404)
	}
	if write && r.URL.RawQuery != "" {
		return nil, productInvalid()
	}
	match := noticeRoute.FindStringSubmatch(path)
	kind := "create"
	if match != nil && match[2] != "" {
		kind = match[2]
	}
	permission := "notices.read"
	if write {
		permission = map[string]string{"create": "notices.create", "save": "notices.update", "publish": "notices.publish", "withdraw": "notices.withdraw"}[kind]
	}
	a, e := h.actor(r, id, permission)
	if e != nil {
		return nil, e
	}
	if operation := noticeOperationRoute.FindStringSubmatch(path); operation != nil {
		if write || r.URL.RawQuery != "" {
			return nil, failure("not_found", 404)
		}
		return s.NoticeCommandResult(r.Context(), a, operation[1])
	}
	if path == "/v1/operations/notices" {
		if !write {
			q, e := query(r, "invalid_operations_product_request", "after", "limit")
			if e != nil {
				return nil, e
			}
			return s.NoticeList(r.Context(), a, q)
		}
		input, e := jsonBody(r, 65536)
		if e != nil {
			return nil, e
		}
		return s.NoticeCreate(r.Context(), a, input)
	}
	if match != nil {
		if write && match[2] != "" {
			input, e := jsonBody(r, 65536)
			if e != nil {
				return nil, e
			}
			if kind == "save" {
				return s.NoticeSave(r.Context(), a, match[1], input)
			}
			return s.NoticeAction(r.Context(), a, match[1], kind, input)
		}
		if !write && match[2] == "" {
			if r.URL.RawQuery != "" {
				return nil, productInvalid()
			}
			return s.NoticeGet(r.Context(), a, match[1])
		}
	}
	return nil, failure("not_found", 404)
}

func jsNumber(value string) (float64, error) {
	value = strings.TrimFunc(value, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' })
	if value == "" {
		return 0, nil
	}
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "0x") || strings.HasPrefix(lower, "0b") || strings.HasPrefix(lower, "0o") {
		number, e := strconv.ParseUint(lower, 0, 64)
		return float64(number), e
	}
	return strconv.ParseFloat(value, 64)
}
