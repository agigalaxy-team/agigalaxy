package native

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type recoveryBrowserEntry struct {
	mu                 sync.Mutex
	expires            time.Time
	scope              ChoiceScope
	service            *NativeRecovery
	stage, id, message string
}

func (b *BrowserChoices) recoveryPage(ctx context.Context, n *NativeRecovery, mode, id string) (map[string]any, error) {
	if !isOne(mode, "set", "recover", "resume") || mode == "resume" && !handoffUUID(id) || mode != "resume" && id != "" {
		return nil, connectionFailure("identity_recovery_input_invalid")
	}
	scope, e := b.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	if mode == "set" && scope.Owner == "" {
		return nil, connectionFailure("local_identity_required")
	}
	stage := mode
	if mode == "recover" {
		id = uuid.NewString()
	}
	if mode == "resume" {
		var row map[string]any
		e = b.store.With(ctx, false, func(dir string) error {
			_, e := readJSON(connectionRecordPath(dir, recoveryRecordKey(n.runtime.config.Endpoint, id)), &row)
			return e
		})
		if e != nil || row == nil {
			return nil, connectionFailure("identity_recovery_material_unavailable")
		}
		if row["kind"] == "set-recovery" {
			if row["subjectId"] != scope.Owner {
				return nil, connectionFailure("native_choice_binding_changed")
			}
			if row["state"] == "registered" {
				stage = "done"
			} else {
				stage = "set-save"
			}
		} else if row["kind"] == "recover" {
			if scope.Owner == row["subjectId"] && scope.DeviceID == row["deviceId"] {
				if row["state"] == "registered" {
					stage = "done"
				} else {
					stage = "recover-save"
				}
			} else {
				stage = "recover-reconcile"
			}
		} else {
			return nil, connectionFailure("identity_recovery_material_unavailable")
		}
	}
	token := make([]byte, 24)
	if _, e = rand.Read(token); e != nil {
		return nil, e
	}
	path := "/identity-recovery/" + hex.EncodeToString(token)
	b.mu.Lock()
	defer b.mu.Unlock()
	if e = b.startLocked(); e != nil {
		return nil, e
	}
	b.pruneLocked()
	if b.recoveryEntries == nil {
		b.recoveryEntries = map[string]*recoveryBrowserEntry{}
	}
	b.recoveryEntries[path] = &recoveryBrowserEntry{expires: b.now().Add(10 * time.Minute), scope: scope, service: n, stage: stage, id: id}
	return map[string]any{"state": "user-choice-needs-browser", "url": b.origin + path, "expiresAt": b.recoveryEntries[path].expires.UnixMilli(), "reviewSurface": "temporary-local-browser", "recoveryCodeReturned": false, "sideEffect": false}, nil
}
func recoveryReply(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
func (b *BrowserChoices) serveRecovery(w http.ResponseWriter, r *http.Request, page *recoveryBrowserEntry, origin string) {
	if r.Method != "GET" && r.Method != "POST" {
		recoveryReply(w, 405, "Method unavailable")
		return
	}
	if r.URL.RawQuery != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		recoveryReply(w, 403, "本机恢复页面请求无效。")
		return
	}
	page.mu.Lock()
	defer page.mu.Unlock()
	if !page.expires.After(b.now()) {
		recoveryReply(w, 404, "本次恢复页面已过期。")
		return
	}
	if e := b.scope(r.Context(), page.scope); e != nil {
		recoveryReply(w, 409, "本机身份或设备已改变，请重新打开恢复页面。")
		return
	}
	if r.Method == "POST" {
		if r.Header.Get("Origin") != origin || strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/x-www-form-urlencoded" {
			recoveryReply(w, 403, "请在本机恢复页面操作。")
			return
		}
		body, e := io.ReadAll(io.LimitReader(r.Body, 4097))
		if e != nil || len(body) > 4096 {
			recoveryReply(w, 400, "输入无效。")
			return
		}
		form, e := url.ParseQuery(string(body))
		clear(body)
		if e != nil || len(form["action"]) != 1 {
			recoveryReply(w, 400, "输入无效。")
			return
		}
		action := form.Get("action")
		page.message = ""
		switch {
		case page.stage == "set" && action == "prepare" && len(form) == 1:
			result, e := page.service.PrepareSet(r.Context(), &page.scope)
			if e != nil {
				page.message = "无法准备恢复码，当前身份未改变。"
			} else {
				page.id = text(result["operationId"])
				page.stage = "set-save"
			}
		case page.stage == "set-save" && action == "saved" && len(form) == 1:
			result, e := page.service.ConfirmSet(r.Context(), page.id, &page.scope)
			if e != nil {
				page.message = "结果暂不明；请再次核对原操作，不会自动重发。"
			} else if uploadObject(result["receipt"])["state"] == "committed" {
				page.stage = "done"
				page.message = "恢复码已登记。原身份和资料保持不变。"
			} else if uploadObject(result["receipt"])["state"] == "requested" {
				page.stage = "set-retry"
				page.message = "服务记录原操作仍待提交。可由本人确认重试原签名。"
			} else {
				page.message = "原操作尚未完成，请稍后核对。"
			}
		case page.stage == "recover" && action == "recover" && len(form) == 2 && len(form["code"]) == 1:
			code := form.Get("code")
			delete(form, "code")
			result, e := page.service.recoverReviewedID(r.Context(), page.id, code, &page.scope)
			code = ""
			if result != nil {
				page.id = text(result["operationId"])
			}
			if e != nil {
				if page.id != "" {
					page.stage = "recover-reconcile"
					page.message = "结果暂不明，请核对原操作；不会自动重发。"
				} else {
					page.message = "恢复码无效、已用过，或当前服务不可用。"
				}
			} else if result["state"] == "registered-awaiting-save-declaration" {
				page.scope, e = b.store.ChoiceScope(r.Context())
				if e != nil {
					page.message = "设备状态已改变，请重新打开原操作。"
					page.stage = "recover-reconcile"
				} else {
					page.stage = "recover-save"
				}
			} else {
				page.stage = "recover-reconcile"
				page.message = "原操作尚未完成，请核对回执。"
			}
		case page.stage == "recover-reconcile" && action == "reconcile" && len(form) == 1:
			result, e := page.service.Reconcile(r.Context(), page.id)
			if e != nil {
				page.message = "无法核对原操作，请稍后重试。"
			} else if result["state"] == "registered-awaiting-save-declaration" || result["state"] == "registered" {
				page.scope, e = b.store.ChoiceScope(r.Context())
				if e != nil {
					page.message = "请重新打开原操作。"
				} else if result["state"] == "registered" {
					page.stage = "done"
					page.message = "恢复及保存声明已完成；连接需要另行确认。"
				} else {
					page.stage = "recover-save"
				}
			} else if result["state"] == "requested" {
				page.stage = "recover-retry"
				page.message = "服务记录原操作仍待提交。可由本人确认重试原签名。"
			} else if result["state"] == "not-dispatched" {
				page.stage = "recover"
				page.id = uuid.NewString()
				page.message = "原操作尚未签名或提交；可重新输入恢复码。"
			} else {
				page.message = "原操作尚未确认；没有重新提交。"
			}
		case page.stage == "recover-save" && action == "saved" && len(form) == 1:
			result, e := page.service.ConfirmNextSaved(r.Context(), page.id, &page.scope)
			if e != nil {
				page.message = "保存声明结果暂不明；请再次核对原操作，不会自动重发。"
			} else if uploadObject(result["receipt"])["state"] == "committed" {
				page.stage = "done"
				page.message = "恢复及保存声明已完成；连接需要另行确认。"
			} else if uploadObject(result["receipt"])["state"] == "requested" {
				page.stage = "declaration-retry"
				page.message = "保存声明仍待提交。可由本人确认重试原签名。"
			} else {
				page.message = "保存声明尚未完成，请稍后核对。"
			}
		case (page.stage == "set-retry" || page.stage == "recover-retry" || page.stage == "declaration-retry") && action == "retry" && len(form) == 1:
			previous := page.stage
			result, e := page.service.RetryOriginalReviewed(r.Context(), page.id, &page.scope)
			if e != nil {
				page.message = "结果暂不明，请重新核对原操作。"
				if previous == "set-retry" {
					page.stage = "set-save"
				} else if previous == "recover-retry" {
					page.stage = "recover-reconcile"
				} else {
					page.stage = "recover-save"
				}
			} else if previous == "recover-retry" && result["state"] == "registered-awaiting-save-declaration" {
				page.scope, e = b.store.ChoiceScope(r.Context())
				if e != nil {
					page.stage = "recover-reconcile"
					page.message = "请重新打开原操作。"
				} else {
					page.stage = "recover-save"
				}
			} else if previous == "set-retry" {
				page.stage = "set-save"
				page.message = "请核对并完成保存声明。"
			} else if previous == "declaration-retry" {
				page.stage = "recover-save"
				page.message = "请核对并完成保存声明。"
			} else {
				page.stage = "recover-reconcile"
				page.message = "请继续核对原操作。"
			}
		default:
			recoveryReply(w, 400, "本次操作与页面状态不匹配。")
			return
		}
	}
	code := ""
	if page.stage == "set-save" || page.stage == "recover-save" {
		var e error
		code, e = page.service.codeForLocalDisplay(r.Context(), page.id)
		if e != nil {
			page.message = "本机恢复材料暂不可用。"
		}
	}
	var output strings.Builder
	data := struct{ Path, Stage, Message, Code, ID string }{r.URL.Path, page.stage, page.message, code, page.id}
	if e := recoveryPageTemplate.Execute(&output, data); e != nil {
		recoveryReply(w, 500, "恢复页面暂不可用。")
		return
	}
	recoveryReply(w, 200, output.String())
}

var recoveryPageTemplate = template.Must(template.New("identity-recovery").Parse(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>银河 · 身份恢复</title><style>body{font:16px/1.6 system-ui;max-width:680px;margin:36px auto;padding:0 18px}textarea,code{width:100%;overflow-wrap:anywhere}button{font:inherit;padding:10px 18px;margin:8px 8px 0 0}.secret{padding:16px;border:1px solid #777;user-select:all}</style><h1>银河身份恢复</h1>{{if .ID}}<p>原操作编号：<span>{{.ID}}</span></p>{{end}}{{if .Message}}<p>{{.Message}}</p>{{end}}{{if eq .Stage "set"}}<p>为当前身份准备新的恢复码。请亲自保存；确认保存后才登记，之前的恢复码将被替换。</p><form method="post" action="{{.Path}}"><button name="action" value="prepare">准备恢复码</button></form>{{else if eq .Stage "recover"}}<p>仅在本机输入原恢复码。恢复将保留原身份，撤销此服务上原设备与绑定，并生成新的恢复码。资料恢复和重新连接分别确认。</p><form method="post" action="{{.Path}}"><label for="code">原恢复码</label><textarea id="code" name="code" required autocomplete="off" spellcheck="false" rows="4"></textarea><button name="action" value="recover">本人确认恢复此身份</button></form>{{else if or (eq .Stage "set-save") (eq .Stage "recover-save")}}<p>请在自己的安全位置保存此恢复码。不要发送给助手或其他人。它只显示在本机页面。</p><p class="secret"><code>{{.Code}}</code></p><form method="post" action="{{.Path}}"><button name="action" value="saved">本人已保存此恢复码</button></form>{{else if or (eq .Stage "set-retry") (eq .Stage "recover-retry") (eq .Stage "declaration-retry")}}<p>已核对服务记录；确认仅重试同一操作的原签名字节，不生成新身份或新操作。</p><form method="post" action="{{.Path}}"><button name="action" value="retry">本人确认重试原操作</button></form>{{else if eq .Stage "recover-reconcile"}}<p>只查询原操作回执，不自动重新提交。</p><form method="post" action="{{.Path}}"><button name="action" value="reconcile">核对原操作</button></form>{{else}}<p>可关闭此页面。</p>{{end}}</html>`))

func registerNativeRecoveryTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	recovery := NewNativeRecovery(runtime)
	input := objectSchema(map[string]any{"action": map[string]any{"type": "string", "enum": []string{"set", "recover", "resume"}}, "operationId": materialUUID()}, "action")
	addNativeTool(server, &mcp.Tool{Name: "galaxy_identity_recovery", InputSchema: input, Description: "Open the temporary local identity recovery page. Recovery codes are entered and displayed only to the person there; never supply a code in tool input. Recovery changes device control only and does not restore local data or connect automatically.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "identity_recovery_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var args struct {
			Action      string `json:"action"`
			OperationID string `json:"operationId,omitempty"`
		}
		if e := protocol.Decode(req.Params.Arguments, &args); e != nil {
			return toolError(fault.New("identity_recovery_input_invalid", 400))
		}
		v, e := tools.browser.recoveryPage(ctx, recovery, args.Action, args.OperationID)
		if e != nil {
			return toolError(e)
		}
		return toolResult(v)
	})
}
