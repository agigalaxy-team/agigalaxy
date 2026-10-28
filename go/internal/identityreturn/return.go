// Package identityreturn preserves the original browser-only account return
// surface. Account authentication/association remains in accountlinks.Callback.
package identityreturn

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"errors"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

// Original HTML template and shared CSS/script bytes from
// packages/galaxy-official/src/adapters/http/identity-callback-page.mjs.
//
//go:embed assets/return.html assets/return.css assets/return.js
var pages embed.FS

const returnLifetime = 5 * time.Minute
const returnLimit = 2048

type Callback func(context.Context, string, string) (string, error)
type Options struct {
	Endpoint      string
	Callback      Callback
	Next          http.Handler
	RecordFailure func(context.Context, int, string)
	Now           func() time.Time
}
type Handler struct {
	endpoint      string
	callback      Callback
	next          http.Handler
	recordFailure func(context.Context, int, string)
	now           func() time.Time
	mu            sync.Mutex
	tickets       map[string]displayTicket
	order         []string
}
type displayTicket struct {
	success bool
	status  int
	expires time.Time
}

var returnPath = regexp.MustCompile(`(?i)^/v1/identity/return/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)
var callbackPath = regexp.MustCompile(`^/v1/identity/callback/([a-z0-9][a-z0-9._-]{0,63})$`)

func New(options Options) (*Handler, error) {
	endpoint, e := url.Parse(options.Endpoint)
	if e != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.Path != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" || options.Callback == nil {
		return nil, fault.New("identity_return_configuration_invalid", 500)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Handler{endpoint: options.Endpoint, callback: options.Callback, next: options.Next, recordFailure: options.RecordFailure, now: options.Now, tickets: map[string]displayTicket{}}, nil
}
func qualityNumber(value string) float64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	var number float64
	var e error
	if strings.HasPrefix(value, "0x") || strings.HasPrefix(value, "0b") || strings.HasPrefix(value, "0o") {
		var integer uint64
		integer, e = strconv.ParseUint(value, 0, 64)
		number = float64(integer)
	} else {
		number, e = strconv.ParseFloat(value, 64)
	}
	if e != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 1 {
		return 0
	}
	return number
}

// AcceptsHTML preserves the original last-value media-quality negotiation. An
// API request never becomes HTML merely because it contains a wildcard Accept.
func AcceptsHTML(request *http.Request) bool {
	mode := strings.Join(request.Header.Values("Sec-Fetch-Mode"), ",")
	if mode != "" && mode != "navigate" {
		return false
	}
	accept := strings.Join(request.Header.Values("Accept"), ",")
	if accept == "" {
		return false
	}
	qualities := map[string]float64{}
	for _, part := range strings.Split(accept, ",") {
		parts := strings.Split(strings.ToLower(strings.TrimSpace(part)), ";")
		quality := float64(1)
		for _, parameter := range parts[1:] {
			parameter = strings.TrimSpace(parameter)
			if strings.HasPrefix(parameter, "q=") {
				quality = qualityNumber(parameter[2:])
				break
			}
		}
		qualities[parts[0]] = quality
	}
	return qualities["text/html"] > 0 && qualities["text/html"] > qualities["application/json"]
}
func securityHeaders(w http.ResponseWriter) {
	vary := []string{}
	present := false
	for _, part := range strings.Split(strings.Join(w.Header().Values("Vary"), ","), ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			vary = append(vary, part)
			if strings.EqualFold(part, "Accept") {
				present = true
			}
		}
	}
	if !present {
		vary = append(vary, "Accept")
	}
	w.Header().Set("Vary", strings.Join(vary, ", "))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
}
func cleanRedirect(w http.ResponseWriter, path string) {
	securityHeaders(w)
	w.Header().Set("Location", path)
	w.Header().Del("Content-Type")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	w.WriteHeader(http.StatusSeeOther)
}
func inactive(status int) bool {
	switch status {
	case 400, 401, 403, 404, 409, 410:
		return true
	}
	return false
}
func pageBytes(success bool, status int, association, expired bool) []byte {
	title, lead := "账户服务暂时不可用", "请稍后重试。"
	if expired {
		title, lead = "链接已过期", "请回到原窗口重新登录。"
	} else if success {
		title, lead = "继续关联账户", "在原窗口确认后即可完成。"
	} else if inactive(status) {
		title, lead = "登录未完成", "请返回原窗口重试。"
	}
	result := "failed"
	if success {
		result = "ready"
	}
	eyebrow := "银河在线账户"
	actions := `<p><a class="primary" href="https://agigalaxy.org/app/account">返回账户</a></p>`
	scriptTag := ""
	if association {
		eyebrow = "银河账户关联"
		actions = `<div class="actions"><button class="primary" id="return-to-origin" type="button" hidden>返回原窗口</button><p class="return-help" id="return-help" role="status">回到原网页或银河客户端继续。</p></div><p><a class="secondary" href="https://agigalaxy.org/app/account">账户中心</a></p>`
		scriptTag = "<script>" + string(returnScript) + "</script>"
	}
	return []byte(strings.NewReplacer("@@TITLE@@", title, "@@LEAD@@", lead, "@@RESULT@@", result, "@@EYEBROW@@", eyebrow, "@@ACTIONS@@", actions, "@@STYLE@@", string(returnStyle), "@@SCRIPT_TAG@@", scriptTag).Replace(string(returnTemplate)))
}

func originalAsset(name string) []byte {
	body, e := pages.ReadFile("assets/" + name)
	if e != nil {
		panic("missing embedded identity return asset")
	}
	return body
}

var returnTemplate = originalAsset("return.html")
var returnStyle = originalAsset("return.css")
var returnScript = originalAsset("return.js")

func htmlResponse(w http.ResponseWriter, success bool, status int, association, expired bool) {
	body := pageBytes(success, status, association, expired)
	sum := sha256.Sum256(returnStyle)
	csp := "default-src 'none'; style-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'; "
	if association {
		sum = sha256.Sum256(returnScript)
		csp += "script-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'; "
	}
	csp += "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	securityHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", csp)
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
func failure(err error) (int, string) {
	var known *fault.Error
	if errors.As(err, &known) && known.Status >= 400 && known.Status <= 599 {
		return known.Status, known.Code
	}
	return 500, "internal_error"
}
func (h *Handler) record(ctx context.Context, status int, code string) {
	if h.recordFailure != nil {
		h.recordFailure(ctx, status, code)
	}
}
func (h *Handler) purgeLocked() {
	now := h.now()
	order := h.order[:0]
	for _, id := range h.order {
		entry, ok := h.tickets[id]
		if ok && entry.expires.After(now) {
			order = append(order, id)
		} else {
			delete(h.tickets, id)
		}
	}
	h.order = order
}
func (h *Handler) remember(success bool, status int) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.purgeLocked()
	for len(h.tickets) >= returnLimit {
		id := h.order[0]
		h.order = h.order[1:]
		delete(h.tickets, id)
	}
	id := uuid.NewString()
	h.tickets[id] = displayTicket{success: success, status: status, expires: h.now().Add(returnLifetime)}
	h.order = append(h.order, id)
	return "/v1/identity/return/" + id
}
func (h *Handler) DispatchReturn(w http.ResponseWriter, r *http.Request) bool {
	match := returnPath.FindStringSubmatch(r.URL.Path)
	if r.Method != "GET" || match == nil {
		return false
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.Fragment != "" {
		cleanRedirect(w, r.URL.Path)
		return true
	}
	h.mu.Lock()
	h.purgeLocked()
	entry, ok := h.tickets[strings.ToLower(match[1])]
	h.mu.Unlock()
	if !ok {
		htmlResponse(w, false, 404, true, true)
	} else {
		htmlResponse(w, entry.success, entry.status, true, false)
	}
	return true
}

// NavigationError is the original read-only HTML error surface for browser
// /v1/account/login or callback failures. API clients retain their JSON handler.
func (h *Handler) NavigationError(w http.ResponseWriter, r *http.Request, err error) bool {
	if !AcceptsHTML(r) {
		return false
	}
	status, code := failure(err)
	h.record(r.Context(), status, code)
	htmlResponse(w, false, status, false, false)
	return true
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.DispatchReturn(w, r) {
		return
	}
	match := callbackPath.FindStringSubmatch(r.URL.Path)
	if r.Method == "GET" && match != nil {
		securityHeaders(w)
		if AcceptsHTML(r) {
			state, err := h.callback(r.Context(), match[1], h.endpoint+r.URL.RequestURI())
			success, status := false, 200
			if err == nil && state == "awaiting-local-signature" {
				success = true
			} else {
				code := "internal_error"
				status = 500
				if err != nil {
					status, code = failure(err)
				}
				h.record(r.Context(), status, code)
			}
			cleanRedirect(w, h.remember(success, status))
			return
		}
	}
	if h.next != nil {
		h.next.ServeHTTP(w, r)
		return
	}
	http.NotFound(w, r)
}
