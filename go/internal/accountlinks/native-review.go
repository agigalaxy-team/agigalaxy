package accountlinks

import (
	"html/template"
	"io"
	"net/http"
	"net/url"
	"strings"
)

func (l *Links) serveNativeReview(w http.ResponseWriter, r *http.Request, ticket string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	if !validUUID(ticket) || r.URL.RawQuery != "" || (r.Method != "GET" && r.Method != "POST") {
		http.NotFound(w, r)
		return
	}
	action := ""
	if r.Method == "POST" {
		if r.Header.Get("Origin") != l.Registry.Endpoint || strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/x-www-form-urlencoded" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 100))
		form, parseErr := url.ParseQuery(string(raw))
		action = form.Get("action")
		if err != nil || parseErr != nil || len(form) != 1 || len(form["action"]) != 1 || (action != "allow" && action != "decline") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
	}
	l.purge(r.Context())
	view := struct{ Email, Subject, State string }{State: "expired"}
	l.mu.Lock()
	for _, p := range l.pending {
		if p.nativeReview != ticket {
			continue
		}
		if p.state == "awaiting-native-approval" {
			if action == "allow" {
				p.state = "native-approved"
			}
			if action == "decline" {
				p.state = "canceled"
			}
		}
		view.Email, view.Subject, view.State = p.verified.Email, p.subject, p.state
		break
	}
	l.mu.Unlock()
	if r.Method == "POST" {
		http.Redirect(w, r, r.URL.Path, http.StatusSeeOther)
		return
	}
	if view.State == "expired" {
		w.WriteHeader(http.StatusGone)
	}
	_ = nativeReviewTemplate.Execute(w, view)
}

var nativeReviewTemplate = template.Must(template.New("native-review").Parse(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>关联银河账户</title><style>body{font:16px/1.65 system-ui;max-width:600px;margin:12vh auto 0;padding:0 24px;color:#29232a}header,dt{color:#716471}dd{margin:0 0 12px;overflow-wrap:anywhere}button{font:inherit;padding:10px 20px;margin:8px 8px 0 0;border:1px solid #d7c9d2;border-radius:8px;background:white;cursor:pointer}button:first-child{background:#873e62;color:white;border-color:#873e62}button:focus-visible{outline:3px solid #dbaac1;outline-offset:3px}</style><header>AGI Galaxy</header><h1>关联银河账户</h1>{{if eq .State "awaiting-native-approval"}}<dl><dt>当前登录账户</dt><dd>{{.Email}}</dd><dt>要关联的本机 ID</dt><dd>{{.Subject}}</dd></dl><p>仅在这次请求是你从当前客户端发起时确认。关联不会上传本机资料。</p><form method="post"><button name="action" value="allow">确认关联</button><button name="action" value="decline">取消</button></form>{{else if or (eq .State "native-approved") (eq .State "awaiting-local-signature")}}<p>已确认关联。客户端会继续处理，可在原窗口查看结果。</p>{{else if eq .State "canceled"}}<p>已取消关联。</p>{{else}}<p>这次关联已过期，请回到原窗口。</p>{{end}}</html>`))
