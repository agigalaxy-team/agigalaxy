package native

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type webHandoffHTTP struct{ server *http.Server }

func (b *webIdentityBridge) start() error {
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return e
	}
	b.origin = "http://" + listener.Addr().String()
	server := &http.Server{Handler: http.HandlerFunc(b.serveHTTP), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 10 * time.Second}
	b.transport = &webHandoffHTTP{server}
	b.mu.Lock()
	e = b.save(context.Background())
	b.mu.Unlock()
	if e != nil {
		b.closed.Store(true)
		_ = listener.Close()
		return e
	}
	go func() { _ = server.Serve(listener) }()
	b.timer = time.AfterFunc(180*time.Second, func() {
		b.mu.Lock()
		if !isOne(b.state, "completed", "canceled") {
			b.state = "expired"
		}
		b.mu.Unlock()
		_ = b.Close()
	})
	return nil
}
func (b *webIdentityBridge) Close() error {
	if b.closed.Swap(true) {
		return nil
	}
	if b.timer != nil {
		b.timer.Stop()
	}
	if b.transport != nil {
		_ = b.transport.server.Close()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !isOne(b.state, "completed", "canceled", "expired") {
		b.state = "stopped"
	}
	return b.save(context.Background())
}
func webDescription(path string) string {
	switch path {
	case "/app/settings/identity?section=account":
		return "查看当前银河身份与官方账户的关联。"
	case "/app/account?section=access":
		return "回到账户中心，继续接入自己的 AI。"
	case "/app/account":
		return "回到账户中心，继续原来的事情。"
	case "/app/publish":
		return "继续填写求助。"
	case "/app/bookmarks":
		return "继续查看自己的收藏。"
	}
	if strings.HasPrefix(path, "/app/search?") {
		query, _ := url.ParseQuery(strings.SplitN(path, "?", 2)[1])
		return "围绕“" + query.Get("q") + "”查找方法，随后返回原求助。"
	}
	for _, pair := range [][2]string{{"/app/tasks/", "继续阅读与处理原求助。"}, {"/app/capsules", "阅读与使用方法。"}, {"/app/rooms/", "继续原来的对话。"}, {"/app/projects/", "继续查看原项目。"}, {"/app/community", "继续阅读原来的社区内容。"}} {
		if strings.HasPrefix(path, pair[0]) {
			return pair[1]
		}
	}
	return "继续原来选择的银河页面。"
}
func (b *webIdentityBridge) page() (string, string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if e := b.current(context.Background()); e != nil {
		return "", "", e
	}
	groups := []any{}
	for _, v := range trustArray(webContracts()["scopeGroups"]) {
		group := psObject(v)
		items := []any{}
		for _, v := range trustArray(group["items"]) {
			item := psObject(v)
			if connectionIncludes(b.scopes, text(item["key"])) {
				items = append(items, item)
			}
		}
		if len(items) > 0 {
			groups = append(groups, map[string]any{"title": group["title"], "items": items})
		}
	}
	boot := map[string]any{"protocol": webIdentityProtocol, "version": 1, "handoffId": b.id, "navigationId": b.navigationID, "website": b.context["website"], "subjectId": b.lease.scope.Owner, "endpoint": b.lease.scope.Endpoint, "expiresAt": b.expires, "scopeGroups": groups, "targetUrl": text(b.context["website"]) + "/app/settings/identity?" + webQuery("agentConnect", b.id, "agentBridgeOrigin", b.origin, "agentNavigation", b.navigationID, "returnTo", b.target)}
	raw, e := protocol.Encode(boot)
	if e != nil {
		return "", "", e
	}
	script := "(" + webHandoffBrowser + ")(" + strings.ReplaceAll(string(raw), "<", "\\u003c") + ");"
	nonceBytes := make([]byte, 18)
	if _, e = rand.Read(nonceBytes); e != nil {
		return "", "", e
	}
	nonce := base64.StdEncoding.EncodeToString(nonceBytes)
	page := strings.NewReplacer("{{DESCRIPTION}}", html.EscapeString(webDescription(b.target)), "{{TARGET}}", html.EscapeString(b.target), "{{ENDPOINT}}", html.EscapeString(b.lease.scope.Endpoint), "{{SUBJECT}}", html.EscapeString(b.lease.scope.Owner), "{{NONCE}}", nonce, "{{SCRIPT}}", script).Replace(webHandoffHTML)
	return page, nonce, nil
}
func webJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	raw, e := protocol.Encode(value)
	if e == nil {
		_, _ = w.Write(raw)
	}
}
func (b *webIdentityBridge) serveHTTP(w http.ResponseWriter, r *http.Request) {
	errorReply := func(status int, code string) { webJSON(w, status, map[string]any{"error": code}) }
	if r.Host != strings.TrimPrefix(b.origin, "http://") {
		errorReply(403, "web_identity_local_host_required")
		return
	}
	base := "/connect/" + b.id
	path := r.RequestURI
	if path != base && path != base+"/state" && path != base+"/message" && path != base+"/choice" {
		errorReply(404, "web_identity_local_path_required")
		return
	}
	var value map[string]any
	var e error
	if r.Method == "GET" {
		if path == base {
			page, nonce, err := b.page()
			if err != nil {
				errorReply(409, webCode(err))
				return
			}
			headers := w.Header()
			headers.Set("Content-Type", "text/html; charset=utf-8")
			headers.Set("Cache-Control", "no-store")
			headers.Set("Referrer-Policy", "same-origin")
			headers.Set("X-Content-Type-Options", "nosniff")
			headers.Set("X-Frame-Options", "DENY")
			headers.Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
			_, _ = io.WriteString(w, page)
			return
		}
		if path != base+"/state" {
			errorReply(405, "web_identity_method_invalid")
			return
		}
		b.mu.Lock()
		e = b.current(r.Context())
		if e == nil {
			value = b.stateWithin()
		}
		b.mu.Unlock()
	} else if r.Method == "POST" {
		if r.Header.Get("Origin") != b.origin || isOne(r.Header.Get("Sec-Fetch-Site"), "cross-site", "same-site") {
			errorReply(403, "web_identity_local_origin_required")
			return
		}
		contentType := strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]
		if path == base+"/message" {
			if contentType != "application/json" {
				errorReply(415, "web_identity_content_type_invalid")
				return
			}
			raw, err := io.ReadAll(io.LimitReader(r.Body, 28001))
			if err != nil {
				errorReply(409, "web_identity_message_invalid")
				return
			}
			if len(raw) > 28000 {
				errorReply(409, "web_identity_message_too_large")
				return
			}
			var message map[string]any
			if protocol.Decode(raw, &message) != nil || message == nil {
				errorReply(409, "web_identity_message_invalid")
				return
			}
			value, e = b.accept(r.Context(), message)
		} else if path == base+"/choice" {
			if contentType != "application/x-www-form-urlencoded" {
				errorReply(415, "web_identity_content_type_invalid")
				return
			}
			raw, err := io.ReadAll(io.LimitReader(r.Body, 101))
			if err != nil || len(raw) > 100 {
				errorReply(409, "web_identity_message_too_large")
				return
			}
			form, err := url.ParseQuery(string(raw))
			if err != nil || len(form) != 1 || len(form["action"]) != 1 {
				errorReply(409, "web_identity_choice_invalid")
				return
			}
			value, e = b.choose(r.Context(), form.Get("action"))
		} else {
			errorReply(405, "web_identity_method_invalid")
			return
		}
	} else {
		errorReply(405, "web_identity_method_invalid")
		return
	}
	if e != nil {
		code := webCode(e)
		b.mu.Lock()
		b.errorCode = code
		b.mu.Unlock()
		errorReply(409, code)
		return
	}
	webJSON(w, 200, value)
}
