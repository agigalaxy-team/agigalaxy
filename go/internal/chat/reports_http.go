package chat

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type ReportHandler struct {
	Service  *ReportService
	Identity HTTPIdentity
	Next     http.Handler
}

var reportCookieRoute = regexp.MustCompile(`^/v1/account/chat-reports/([a-z]+)$`)
var reportOperatorRoute = regexp.MustCompile(`^/v1/operations/chat-reports(?:/([0-9a-f-]{36})(?:/(event|attachments/([0-9a-f-]{36})/content))?)?$`)
var reportReceiptRoute = regexp.MustCompile(`^/v1/operations/chat-reports/([0-9a-f-]{36})/operations/([0-9a-f-]{36})$`)
var reportMessageRoute = regexp.MustCompile(`^/v1/operations/chat-reports/([0-9a-f-]{36})/messages/([0-9a-f-]{36})/visibility$`)

func (h ReportHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cookie, operator, receipt, message := reportCookieRoute.FindStringSubmatch(r.URL.Path), reportOperatorRoute.FindStringSubmatch(r.URL.Path), reportReceiptRoute.FindStringSubmatch(r.URL.Path), reportMessageRoute.FindStringSubmatch(r.URL.Path)
	if cookie == nil && operator == nil && receipt == nil && message == nil {
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
	out, binary, e := h.reportDispatch(w, r, id, cookie, operator, receipt, message)
	if binary && e == nil {
		return
	}
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	json.NewEncoder(w).Encode(out)
}
func reportBody(r *http.Request, empty bool) (Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return nil, e
	}
	if len(raw) > 32768 {
		return nil, fail("request_too_large", 413)
	}
	var x Object
	if json.Unmarshal(raw, &x) != nil || x == nil {
		return nil, fail("invalid_json")
	}
	if empty && len(x) > 0 {
		return nil, reportInvalid()
	}
	return x, nil
}
func (h ReportHandler) reportDispatch(w http.ResponseWriter, r *http.Request, request string, cookie, operator, receipt, message []string) (Object, bool, error) {
	s := h.Service
	if s == nil || s.Chat == nil {
		return nil, false, fail("chat_report_service_unavailable", 503)
	}
	ctx := r.Context()
	if cookie != nil {
		method := cookie[1]
		if r.Method != "POST" || r.URL.RawQuery != "" || !has([]string{"config", "source", "query", "report", "event", "receipt", "get"}, method) {
			return nil, false, fail("not_found", 404)
		}
		if _, exists := r.Header["Authorization"]; exists {
			return nil, false, fail("chat_report_account_required", 401)
		}
		if h.Identity == nil {
			return nil, false, fail("official_account_unavailable", 503)
		}
		id, auth, e := h.Identity.Account(r, method == "report" || method == "event")
		if e != nil {
			return nil, false, e
		}
		a := Actor{AccountID: id, Authority: auth, RequestID: request}
		x, e := reportBody(r, method == "config")
		if e != nil {
			return nil, false, e
		}
		var out Object
		switch method {
		case "config":
			out = s.Configuration()
		case "source":
			out, e = s.Source(ctx, a, x)
		case "query":
			out, e = s.Query(ctx, a, x)
		case "report":
			out, e = s.Report(ctx, a, x)
		case "event":
			out, e = s.Event(ctx, a, x)
		case "receipt":
			out, e = s.Receipt(ctx, a, x)
		case "get":
			out, e = s.Get(ctx, a, x)
		}
		return out, false, e
	}
	if s.Admin == nil || s.Admin.Authority == nil {
		return nil, false, fail("business_admin_unavailable", 503)
	}
	authorize := func(write bool, permission string) (operationspermissions.Actor, error) {
		a, e := s.Admin.Authority.AuthorizeOperations(r, write, permission)
		a.RequestID = &request
		return a, e
	}
	if message != nil {
		if r.Method != "POST" || r.URL.RawQuery != "" {
			return nil, false, fail("not_found", 404)
		}
		if _, e := authorize(true, ""); e != nil {
			return nil, false, e
		}
		x, e := reportBody(r, false)
		if e != nil {
			return nil, false, e
		}
		if !has([]string{"hide", "restore", "keep"}, str(x, "action")) {
			return nil, false, reportInvalid()
		}
		auth := func() (operationspermissions.Actor, error) { return authorize(true, "chat-messages."+str(x, "action")) }
		a, e := auth()
		if e != nil {
			return nil, false, e
		}
		v, e := s.OperatorMessageVisibility(ctx, a, Object{"reportId": message[1], "messageId": message[2]}, x, auth)
		return v, false, e
	}
	if receipt != nil {
		if r.Method != "GET" || r.URL.RawQuery != "" {
			return nil, false, fail("not_found", 404)
		}
		a, e := authorize(false, "chat-reports.read")
		if e != nil {
			return nil, false, e
		}
		w.Header().Set("Referrer-Policy", "no-referrer")
		v, e := s.CommandResult(ctx, a, receipt[1], receipt[2])
		return v, false, e
	}
	id, action, attachment := operator[1], operator[2], operator[3]
	write, binary := action == "event", attachment != ""
	method := "GET"
	if write || binary {
		method = "POST"
	}
	if r.Method != method || id != "" && r.URL.RawQuery != "" {
		return nil, false, fail("not_found", 404)
	}
	required := "chat-reports.read"
	if write {
		required = "chat-reports.moderate"
	}
	if binary {
		required = "chat-reports.attachments.read"
	}
	auth := func() (operationspermissions.Actor, error) { return authorize(write || binary, required) }
	a, e := auth()
	if e != nil {
		return nil, false, e
	}
	if binary {
		if _, e = reportBody(r, true); e != nil {
			return nil, false, e
		}
		file, e := s.OperatorAttachment(ctx, a, id, attachment, auth)
		if e != nil {
			return nil, false, e
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(file.Bytes)))
		w.Header().Set("Content-Disposition", `attachment; filename="galaxy-attachment"; filename*=UTF-8''`+strings.ReplaceAll(url.PathEscape(file.Name), "+", "%20"))
		_, e = w.Write(file.Bytes)
		return nil, true, e
	}
	if write {
		x, e := reportBody(r, false)
		if e != nil {
			return nil, false, e
		}
		if str(x, "reportId") != id {
			return nil, false, reportInvalid()
		}
		v, e := s.OperatorEvent(ctx, a, x)
		return v, false, e
	}
	if id != "" {
		v, e := s.OperatorGet(ctx, a, Object{"reportId": id})
		return v, false, e
	}
	x := Object{}
	for k, v := range r.URL.Query() {
		if len(v) != 1 || !has([]string{"roomId", "state", "after", "limit"}, k) {
			return nil, false, reportInvalid()
		}
		x[k] = v[0]
		if k == "limit" {
			n, e := strconv.ParseFloat(v[0], 64)
			if e != nil {
				return nil, false, reportInvalid()
			}
			x[k] = n
		}
	}
	v, e := s.OperatorQuery(ctx, a, x)
	return v, false, e
}
