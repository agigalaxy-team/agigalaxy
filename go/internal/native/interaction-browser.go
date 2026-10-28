package native

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// BrowserChoices is the existing temporary local review surface for clients
// without form elicitation. The HTTP page only records an allow/decline choice;
// the original MCP call alone executes the exact operation under its scope.
type BrowserChoices struct {
	store   *Store
	now     func() time.Time
	mu      sync.Mutex
	server  *http.Server
	origin  string
	entries map[string]*interactionBrowserEntry
	closed  bool
}
type BrowserChoiceInput struct {
	Name    string
	Input   any
	Message string
	Scope   ChoiceScope
}
type interactionBrowserEntry struct {
	key       string
	input     BrowserChoiceInput
	state     string
	expires   time.Time
	exact     []byte
	running   bool
	result    any
	err       error
	completed bool
}

func NewBrowserChoices(store *Store, now func() time.Time) *BrowserChoices {
	if now == nil {
		now = time.Now
	}
	return &BrowserChoices{store: store, now: now, entries: map[string]*interactionBrowserEntry{}}
}
func interactionKey(input BrowserChoiceInput) (string, error) {
	raw, e := identity.Canonical(struct {
		Name  string
		Input any
		Scope ChoiceScope
	}{input.Name, input.Input, input.Scope})
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
func (b *BrowserChoices) pruneLocked() {
	for path, entry := range b.entries {
		if !entry.expires.After(b.now()) && !entry.running {
			delete(b.entries, path)
		}
	}
}
func (b *BrowserChoices) startLocked() error {
	if b.closed {
		return fault.New("native_review_closed", 409)
	}
	if b.server != nil {
		return nil
	}
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return e
	}
	b.origin = "http://" + listener.Addr().String()
	b.server = &http.Server{Handler: http.HandlerFunc(b.serve), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 10 * time.Second}
	server := b.server
	go func() { _ = server.Serve(listener) }()
	return nil
}
func interactionDeadline(input any, now time.Time) time.Time {
	deadline := now.Add(5 * time.Minute)
	raw, e := protocol.Encode(input)
	if e != nil {
		return deadline
	}
	var v map[string]any
	if protocol.Decode(raw, &v) != nil {
		return deadline
	}
	value := v["expiresAt"]
	if value == nil {
		value = initializationMap(v["preview"])["expiresAt"]
	}
	var until time.Time
	switch value := value.(type) {
	case json.Number:
		n, e := value.Float64()
		if e == nil {
			if n < 1e12 {
				n *= 1000
			}
			until = time.UnixMilli(int64(n))
		}
	case string:
		until, _ = time.Parse(time.RFC3339Nano, value)
	}
	if !until.IsZero() && until.Before(deadline) {
		return until
	}
	return deadline
}
func (b *BrowserChoices) scope(ctx context.Context, expected ChoiceScope) error {
	current, e := b.store.ChoiceScope(ctx)
	if e != nil {
		return e
	}
	if current != expected {
		return fault.New("native_choice_binding_changed", 409)
	}
	return nil
}
func (b *BrowserChoices) request(ctx context.Context, input BrowserChoiceInput) (string, *interactionBrowserEntry, error) {
	if b.store == nil {
		return "", nil, fault.New("native_review_store_required", 500)
	}
	if e := b.scope(ctx, input.Scope); e != nil {
		return "", nil, e
	}
	key, e := interactionKey(input)
	if e != nil {
		return "", nil, e
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if e = b.startLocked(); e != nil {
		return "", nil, e
	}
	b.pruneLocked()
	for path, entry := range b.entries {
		if entry.key == key && entry.state != "declined-delivered" {
			return path, entry, nil
		}
	}
	token := make([]byte, 24)
	if _, e = rand.Read(token); e != nil {
		return "", nil, e
	}
	path := "/review/" + hex.EncodeToString(token)
	owner := input.Scope.Owner
	if owner == "" {
		owner = "尚未初始化"
	}
	exact, e := protocol.Encode(map[string]any{"operation": input.Name, "identity": owner, "input": input.Input})
	if e != nil {
		return "", nil, e
	}
	entry := &interactionBrowserEntry{key: key, input: input, state: "pending", expires: interactionDeadline(input.Input, b.now()), exact: exact}
	b.entries[path] = entry
	return path, entry, nil
}

// Review preserves the original poll-the-same-operation lifecycle. Accepted
// results are retained for this exact request; unknown writes are never resent.
func (b *BrowserChoices) Review(ctx context.Context, input BrowserChoiceInput, run func(*ChoiceScope) (any, error)) (any, error) {
	path, entry, e := b.request(ctx, input)
	if e != nil {
		return nil, e
	}
	b.mu.Lock()
	if entry.completed {
		result, e := entry.result, entry.err
		b.mu.Unlock()
		return result, e
	}
	if entry.running {
		b.mu.Unlock()
		return nil, fault.New("native_choice_in_progress", 409)
	}
	if entry.state == "accepted" {
		entry.running = true
		entry.state = "consumed"
		b.mu.Unlock()
		// Scope verification belongs at use time as well as the actual POST. Domain
		// writes additionally check the same scope inside their SQLite write lock.
		var result any
		if e = b.scope(ctx, input.Scope); e == nil {
			result, e = run(&input.Scope)
		}
		b.mu.Lock()
		entry.result = result
		entry.err = e
		entry.running = false
		entry.completed = true
		b.mu.Unlock()
		return result, e
	}
	state := "user-choice-needs-browser"
	if entry.state == "declined" {
		entry.state = "declined-delivered"
		state = "declined"
	}
	result := map[string]any{"state": state, "url": b.origin + path, "expiresAt": entry.expires.UnixMilli(), "sideEffect": false, "reviewSurface": "temporary-local-browser", "operation": input.Name, "preview": input.Input, "retryOriginalOperation": true, "reason": "host-form-elicitation-unavailable"}
	b.mu.Unlock()
	return result, nil
}
func (b *BrowserChoices) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	b.entries = map[string]*interactionBrowserEntry{}
	server := b.server
	b.server = nil
	b.mu.Unlock()
	if server != nil {
		return server.Close()
	}
	return nil
}
func interactionResponse(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
func (b *BrowserChoices) serve(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	b.pruneLocked()
	origin := b.origin
	expected, _ := url.Parse(origin)
	if b.closed || expected == nil || r.Host != expected.Host || r.URL.IsAbs() {
		b.mu.Unlock()
		interactionResponse(w, 403, "本机审阅地址不匹配。")
		return
	}
	entry := b.entries[r.URL.Path]
	if entry == nil {
		b.mu.Unlock()
		interactionResponse(w, 404, "本次审阅不存在或已过期。请返回原宿主查询当前状态。")
		return
	}
	copy := *entry
	b.mu.Unlock()
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" && r.Method != "GET" {
		interactionResponse(w, 403, "拒绝跨站提交。")
		return
	}
	if r.Method == "POST" {
		if r.Header.Get("Origin") != origin || strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/x-www-form-urlencoded" {
			interactionResponse(w, 403, "请在本机审阅页面操作。")
			return
		}
		body, e := io.ReadAll(io.LimitReader(r.Body, 201))
		if e != nil {
			interactionResponse(w, 400, "选择无效。")
			return
		}
		if len(body) > 200 {
			interactionResponse(w, 413, "提交过长。")
			return
		}
		form, e := url.ParseQuery(string(body))
		action := form.Get("action")
		if e != nil || len(form) != 1 || len(form["action"]) != 1 || action != "allow" && action != "decline" {
			interactionResponse(w, 400, "选择无效。")
			return
		}
		if e = b.scope(r.Context(), copy.input.Scope); e != nil {
			interactionResponse(w, 409, "本次身份或设备范围已变化。请返回原宿主重新核对。")
			return
		}
		b.mu.Lock()
		current := b.entries[r.URL.Path]
		if b.closed || current != entry || !entry.expires.After(b.now()) {
			b.mu.Unlock()
			interactionResponse(w, 404, "本次审阅不存在或已过期。请返回原宿主查询当前状态。")
			return
		}
		if entry.state == "pending" {
			if action == "allow" {
				entry.state = "accepted"
			} else {
				entry.state = "declined"
			}
		}
		state := entry.state
		b.mu.Unlock()
		message := "已取消。本次操作没有获得授权。"
		if state == "accepted" {
			message = "已允许本次显示的操作。回到原聊天继续。"
		} else if state == "consumed" {
			message = "本次允许已用于原操作，不能再次授权。"
		}
		interactionResponse(w, 200, "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>银河本机选择</title><p>"+message+"</p>")
		return
	}
	if r.Method != "GET" {
		interactionResponse(w, 405, "Method unavailable")
		return
	}
	if r.URL.RawQuery == "download=1" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Disposition", "attachment; filename=\"galaxy-operation.json\"")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(copy.exact)
		return
	}
	var output strings.Builder
	view := interactionBrowserView(copy.input)
	data := struct {
		Path, State, Until string
		View               interactionChoiceView
	}{r.URL.Path, copy.state, copy.expires.Local().Format("15:04:05"), view}
	if e := interactionReviewTemplate.Execute(&output, data); e != nil {
		interactionResponse(w, 500, "本机审阅页面暂不可用。")
		return
	}
	interactionResponse(w, 200, output.String())
}

type interactionChoiceRow struct{ Label, Text string }
type interactionChoiceView struct {
	Title, Note    string
	Rows, Sections []interactionChoiceRow
}

func interactionBrowserView(input BrowserChoiceInput) interactionChoiceView {
	titles := map[string]string{"galaxy_native_initialize": "创建本机身份", "galaxy_native_connect": "连接银河", "galaxy_local_archive_configure": "保存本机私有原文范围", "galaxy_local_upload_privacy_set": "保存上传类型与范围", "galaxy_local_settings_save": "保存这些选择", "galaxy_local_archive_delete": "删除所选本机原文", "galaxy_local_work_delete": "删除所选本机履历", "galaxy_work_sync_choice": "保存履历到账户", "galaxy_archive_sync_choice": "保存原会话到账户", "galaxy_work_cloud_delete": "删除本人云端履历", "galaxy_archive_cloud_delete": "删除本人云端原会话"}
	title := titles[input.Name]
	if title == "" {
		title = "继续本次操作"
	}
	return interactionChoiceView{Title: title, Note: "只允许这里显示的内容与范围。关闭或取消不会批准。", Rows: []interactionChoiceRow{{"本次内容与范围", input.Message}}, Sections: []interactionChoiceRow{}}
}

var interactionReviewTemplate = template.Must(template.New("review").Parse(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>银河 · {{.View.Title}}</title><style>body{font:16px/1.65 system-ui;max-width:680px;margin:28px auto;padding:0 20px 48px;background:#fff;color:#25252c}header{color:#686471;font-size:14px}h1{font-size:26px;margin:20px 0}h2{font-size:14px;color:#686471;margin:0 0 5px}section{margin:22px 0}.content{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}dl{background:white;border:1px solid #e5e7eb;border-radius:12px;padding:12px 18px}dl div{padding:7px 0}dt{color:#686471;font-size:14px}dd{margin:0;overflow-wrap:anywhere}button{font:inherit;padding:11px 22px;margin:8px 10px 8px 0;border:1px solid #e5e7eb;border-radius:9px;background:white;cursor:pointer}.primary{background:#9d496a;color:white;border-color:#9d496a}button:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid #d8a9be;outline-offset:3px}.muted{font-size:14px;color:#686471}.ref{font-size:14px;color:#686471}.ref{overflow-wrap:anywhere}a{color:#9d496a}</style><header>银河 · 当前宿主的本机选择</header><h1>{{.View.Title}}</h1>{{range .View.Rows}}<section><h2>{{.Label}}</h2><p class="content">{{.Text}}</p></section>{{end}}{{if .View.Sections}}<dl>{{range .View.Sections}}<div><dt>{{.Label}}</dt><dd>{{.Text}}</dd></div>{{end}}</dl>{{end}}<p class="muted">{{.View.Note}}有效至 {{.Until}}。</p>{{if eq .State "pending"}}<form method="post" action="{{.Path}}"><button class="primary" type="submit" name="action" value="allow">允许本次操作</button><button type="submit" name="action" value="decline">取消</button></form>{{else}}<p>{{if eq .State "accepted"}}已允许。可以回到原聊天继续。{{else if eq .State "consumed"}}这次授权已用于原操作。{{else}}已取消，本次操作没有获得授权。{{end}}</p>{{end}}<section aria-label="来源与诊断"><h2>来源与诊断</h2><p>保留本次输入、准确身份与引用，供需要核对或诊断时查看。</p><a href="{{.Path}}?download=1" download="galaxy-operation.json">下载本次完整操作</a></section></html>`))
