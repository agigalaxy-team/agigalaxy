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
// without form elicitation. An approved operation runs once and its result
// is shared by the browser and the originating tool.
type BrowserChoices struct {
	store           *Store
	now             func() time.Time
	mu              sync.Mutex
	server          *http.Server
	origin          string
	entries         map[string]*interactionBrowserEntry
	recoveryEntries map[string]*recoveryBrowserEntry
	closed          bool
}
type choiceAction func(context.Context, *ChoiceScope) (any, error)

type BrowserChoiceInput struct {
	Name                    string
	Input                   any
	Message                 string
	Scope                   ChoiceScope
	LoginURL                string
	ExternalApproval        func(context.Context) (bool, error)
	FirstUseSelectionDigest string
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
	ctx       context.Context
	run       choiceAction
	cancel    context.CancelFunc
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
	for path, entry := range b.recoveryEntries {
		if !entry.expires.After(b.now()) && entry.mu.TryLock() {
			delete(b.recoveryEntries, path)
			entry.mu.Unlock()
		}
	}
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
func (b *BrowserChoices) request(ctx context.Context, input BrowserChoiceInput, run choiceAction) (string, *interactionBrowserEntry, error) {
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
	entry := &interactionBrowserEntry{key: key, input: input, state: "pending", expires: interactionDeadline(input.Input, b.now()), exact: exact, ctx: context.WithoutCancel(ctx), run: run}
	b.entries[path] = entry
	if input.ExternalApproval != nil {
		entry.state = "awaiting-account"
		ctx, cancel := context.WithTimeout(entry.ctx, max(time.Second, entry.expires.Sub(b.now())))
		entry.cancel = cancel
		go b.awaitApproval(ctx, cancel, entry)
	}
	return path, entry, nil
}

// Review presents or retrieves the original operation. Only the browser POST
// can start it; polling the original tool never repeats a write.
func (b *BrowserChoices) Review(ctx context.Context, input BrowserChoiceInput, run choiceAction) (any, error) {
	path, entry, e := b.request(ctx, input, run)
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
		return map[string]any{"state": "user-choice-needs-browser", "processing": true, "url": b.origin + path, "expiresAt": entry.expires.UnixMilli()}, nil
	}
	state := "user-choice-needs-browser"
	if entry.state == "declined" {
		entry.state = "declined-delivered"
		state = "declined"
	}
	result := map[string]any{"state": state, "url": b.origin + path, "expiresAt": entry.expires.UnixMilli(), "sideEffect": false, "reviewSurface": "temporary-local-browser", "operation": input.Name, "preview": input.Input, "retryOriginalOperation": true, "reason": "host-form-elicitation-unavailable"}
	if input.ExternalApproval != nil {
		delete(result, "retryOriginalOperation")
		result["reason"] = "official-account-login"
		result["message"] = "打开页面登录银河账户并确认关联。"
	}
	b.mu.Unlock()
	return result, nil
}
func (b *BrowserChoices) awaitApproval(ctx context.Context, cancel context.CancelFunc, entry *interactionBrowserEntry) {
	defer cancel()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			approved, err := entry.input.ExternalApproval(ctx)
			if err != nil && fault.Status(err) >= 500 {
				continue
			}
			if !approved && err == nil {
				continue
			}
			b.mu.Lock()
			if b.closed || ctx.Err() != nil || entry.state != "awaiting-account" || !entry.expires.After(b.now()) {
				b.mu.Unlock()
				return
			}
			if err != nil {
				entry.state, entry.completed, entry.err = "failed", true, err
				entry.ctx, entry.run, entry.cancel = nil, nil, nil
				b.mu.Unlock()
				return
			}
			b.startExecutionLocked(entry)
			b.mu.Unlock()
			return
		}
	}
}

func (b *BrowserChoices) startExecutionLocked(entry *interactionBrowserEntry) {
	entry.state, entry.running = "processing", true
	ctx, cancel := context.WithTimeout(entry.ctx, 2*time.Minute)
	entry.cancel = cancel
	go b.execute(ctx, cancel, entry)
}

func (b *BrowserChoices) execute(ctx context.Context, cancel context.CancelFunc, entry *interactionBrowserEntry) {
	defer cancel()
	err := b.scope(ctx, entry.input.Scope)
	var result any
	if err == nil {
		result, err = entry.run(ctx, &entry.input.Scope)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	entry.result, entry.err = result, err
	entry.running, entry.completed = false, true
	entry.ctx, entry.run, entry.cancel = nil, nil, nil
	entry.expires = b.now().Add(5 * time.Minute)
	entry.state = "finished"
	if err != nil || interactionResultUncertain(result) {
		entry.state = "unconfirmed"
	}
	if err != nil && fault.Status(err) < 500 {
		entry.state = "failed"
	}
}

func interactionResultUncertain(result any) bool {
	out, ok := result.(map[string]any)
	if !ok {
		return false
	}
	for _, k := range []string{"state", "outcome"} {
		switch out[k] {
		case "unknown", "pending", "processing", "original-operation-needs-reconciliation", "failed", "rejected", "conflict", "declined", "expired":
			return true
		}
	}
	return out["error"] != nil
}

// accountProgress is a view of the same temporary operation, not a second
// link request. Local device connection alone cannot mark this linked.
func (b *BrowserChoices) accountProgress(ctx context.Context, scope ChoiceScope) map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked()
	var selected *interactionBrowserEntry
	var selectedPath string
	for path, entry := range b.entries {
		original := entry.input.Scope
		matches := original.DeviceID == scope.DeviceID
		if !matches && original.DeviceID == "" && entry.input.FirstUseSelectionDigest != "" && (scope.Revision == original.Revision+1 || scope.Revision == original.Revision+2) {
			// First-use bootstrap persists its exact target before changing selection.
			// Only that device, for this original selection, can inherit the operation.
			_ = b.store.With(ctx, false, func(dir string) error {
				var row map[string]any
				_, err := readJSON(connectionRecordPath(dir, "native-first-connect:"+original.Endpoint+":"+original.Owner), &row)
				if err != nil {
					return err
				}
				request := uploadObject(row["request"])
				matches = row["selectionDigest"] == entry.input.FirstUseSelectionDigest && connectionEqual(row["scope"], identityClone(original)) && request["subjectId"] == original.Owner && request["kind"] == "bootstrap" && uploadObject(request["newDevice"])["deviceId"] == scope.DeviceID
				return nil
			})
		}
		if entry.input.Name == "galaxy_native_account_connect" && original.Owner == scope.Owner && original.Endpoint == scope.Endpoint && matches &&
			(selected == nil || entry.expires.After(selected.expires)) {
			selected = entry
			selectedPath = path
		}
	}
	if selected == nil {
		return nil
	}
	result := map[string]any{"state": selected.state, "identity": scope.Owner, "endpoint": scope.Endpoint}
	if selected.state == "awaiting-account" || selected.state == "processing" {
		result["url"] = b.origin + selectedPath
	}
	if selected.completed {
		if selected.result != nil {
			result["result"] = selected.result
		}
		if selected.err != nil {
			result["error"] = runtimeErrorCode(selected.err)
		}
	}
	return result
}

func (b *BrowserChoices) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	for _, entry := range b.entries {
		if entry.cancel != nil {
			entry.cancel()
		}
	}
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
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
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
	if recovery := b.recoveryEntries[r.URL.Path]; recovery != nil {
		b.mu.Unlock()
		b.serveRecovery(w, r, recovery, origin)
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
				b.startExecutionLocked(entry)
			} else {
				entry.state = "declined"
			}
		}
		b.mu.Unlock()
		// Keep the same review layout and make refresh a read of the choice,
		// rather than resubmitting the browser's previous POST.
		http.Redirect(w, r, r.URL.Path, http.StatusSeeOther)
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
	if r.URL.RawQuery == "status=1" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"state": copy.state, "message": interactionOutcome(copy)})
		return
	}
	var output strings.Builder
	view := interactionBrowserView(copy.input)
	data := struct {
		Path, State, Until, LoginURL, Outcome string
		View                                  interactionChoiceView
	}{r.URL.Path, copy.state, copy.expires.Local().Format("15:04:05"), copy.input.LoginURL, interactionOutcome(copy), view}
	if e := interactionReviewTemplate.Execute(&output, data); e != nil {
		interactionResponse(w, 500, "本机审阅页面暂不可用。")
		return
	}
	interactionResponse(w, 200, output.String())
}

func interactionOutcome(entry interactionBrowserEntry) string {
	switch entry.state {
	case "awaiting-account":
		return "请在打开的银河官网页面登录并确认，完成后此页面会显示结果。"
	case "processing":
		return "正在处理，请稍候。"
	case "finished":
		if entry.input.Name == "galaxy_native_account_connect" {
			return "银河账户关联已完成，可以回到原聊天。"
		}
		return userChoiceOutcome(entry.result)
	case "failed":
		return "操作未完成。"
	case "unconfirmed":
		return "结果尚未确认。"
	case "declined", "declined-delivered":
		return "已取消。"
	}
	return ""
}

type interactionChoiceRow struct{ Label, Text string }
type interactionChoiceView struct {
	Title, Note    string
	Rows, Sections []interactionChoiceRow
}

func interactionBrowserView(input BrowserChoiceInput) interactionChoiceView {
	title := userChoiceTitle(input.Name)
	return interactionChoiceView{Title: title, Note: "关闭页面不会确认。", Rows: []interactionChoiceRow{{"本次内容与范围", input.Message}}, Sections: []interactionChoiceRow{}}
}

var interactionReviewTemplate = template.Must(template.New("review").Parse(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>银河 · {{.View.Title}}</title><style>body{font:16px/1.65 system-ui;max-width:680px;margin:28px auto;padding:0 20px 48px;background:#fff;color:#25252c}header{color:#686471;font-size:14px}h1{font-size:26px;margin:20px 0}h2{font-size:14px;color:#686471;margin:0 0 5px}section{margin:22px 0}.content{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}dl{background:white;border:1px solid #e5e7eb;border-radius:12px;padding:12px 18px}dl div{padding:7px 0}dt{color:#686471;font-size:14px}dd{margin:0;overflow-wrap:anywhere}button{font:inherit;padding:11px 22px;margin:8px 10px 8px 0;border:1px solid #e5e7eb;border-radius:9px;background:white;cursor:pointer}.primary{background:#9d496a;color:white;border-color:#9d496a}button:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid #d8a9be;outline-offset:3px}.muted{font-size:14px;color:#686471}.ref{font-size:14px;color:#686471}.ref{overflow-wrap:anywhere}a{color:#9d496a}.login{display:inline-block;padding:10px 18px;border:1px solid #9d496a;border-radius:9px;text-decoration:none}</style><header>AGI Galaxy</header><h1>{{.View.Title}}</h1>{{range .View.Rows}}<section><h2>{{.Label}}</h2><p class="content">{{.Text}}</p></section>{{end}}{{if .View.Sections}}<dl>{{range .View.Sections}}<div><dt>{{.Label}}</dt><dd>{{.Text}}</dd></div>{{end}}</dl>{{end}}<p class="muted">{{.View.Note}}有效至 {{.Until}}。</p>{{if eq .State "awaiting-account"}}{{if .LoginURL}}<a class="login" href="{{.LoginURL}}" target="_blank" rel="noopener noreferrer">登录银河账户</a>{{end}}{{else if eq .State "pending"}}<form method="post" action="{{.Path}}"><button class="primary" type="submit" name="action" value="allow">{{.View.Title}}</button><button type="submit" name="action" value="decline">取消</button></form>{{else}}<p id="outcome">{{.Outcome}}</p>{{end}}{{if eq .State "awaiting-account"}}<p id="outcome">{{.Outcome}}</p>{{end}}<details><summary>查看操作详情</summary><a href="{{.Path}}?download=1" download="galaxy-operation.json">下载本次操作</a></details>{{if or (eq .State "processing") (eq .State "awaiting-account")}}<script>const output=document.getElementById('outcome'); async function poll(){try{const r=await fetch(location.pathname+'?status=1',{cache:'no-store'});if(!r.ok)return;const data=await r.json();output.textContent=data.message;if(data.state==='processing'||data.state==='awaiting-account')setTimeout(poll,2000);}catch(e){setTimeout(poll,3000)}}setTimeout(poll,2000);</script>{{end}}</html>`))
