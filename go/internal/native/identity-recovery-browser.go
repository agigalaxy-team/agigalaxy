package native

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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
	candidates         []recoveryCandidate
}

type recoveryCandidate struct{ ID, Subject, Label, When string }

// Find only records belonging to the active selection or the exact selection
// that initiated recovery. Key contents are never read during discovery.
func recoveryCandidates(ctx context.Context, n *NativeRecovery, scope ChoiceScope) ([]recoveryCandidate, error) {
	var candidates []recoveryCandidate
	err := n.runtime.store.With(ctx, false, func(dir string) error {
		entries, err := os.ReadDir(filepath.Join(dir, "native-v2", "keys"))
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.HasPrefix(name, "recovery-") || !strings.HasSuffix(name, ".pem") {
				continue
			}
			id := strings.TrimSuffix(strings.TrimPrefix(name, "recovery-"), ".pem")
			if !handoffUUID(id) {
				continue
			}
			var row map[string]any
			if _, err := readJSON(connectionRecordPath(dir, recoveryRecordKey(n.runtime.config.Endpoint, id)), &row); err != nil {
				return err
			}
			if row == nil || row["operationId"] != id || row["state"] == "registered" || !connectionSubject.MatchString(text(row["subjectId"])) {
				continue
			}
			label := ""
			switch row["kind"] {
			case "set-recovery":
				if row["subjectId"] != scope.Owner || !connectionEqual(row["scope"], identityClone(scope)) {
					continue
				}
				label = "设置恢复码，等待保存"
			case "recover":
				if !(scope.Owner == row["subjectId"] && scope.DeviceID == row["deviceId"]) && !connectionEqual(row["originalScope"], identityClone(scope)) {
					continue
				}
				label = "恢复身份，等待核对"
				if scope.Owner == row["subjectId"] && scope.DeviceID == row["deviceId"] {
					label = "恢复身份，等待保存恢复码"
				}
			default:
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				continue
			}
			candidates = append(candidates, recoveryCandidate{ID: id, Subject: text(row["subjectId"]), Label: label, When: info.ModTime().Local().Format("2006-01-02 15:04:05")})
		}
		return nil
	})
	return candidates, err
}

func (b *BrowserChoices) recoveryPage(ctx context.Context, n *NativeRecovery, mode, id string) (map[string]any, error) {
	if !isOne(mode, "set", "recover", "resume") || mode == "resume" && id != "" && !handoffUUID(id) || mode != "resume" && id != "" {
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
	var candidates []recoveryCandidate
	if mode == "resume" && id == "" {
		candidates, e = recoveryCandidates(ctx, n, scope)
		if e != nil {
			return nil, e
		}
		switch len(candidates) {
		case 0:
			stage = "no-pending"
		case 1:
			id = candidates[0].ID
		default:
			stage = "select"
		}
	}
	if mode == "recover" {
		id = uuid.NewString()
	}
	if mode == "resume" && id != "" {
		var row map[string]any
		e = b.store.With(ctx, false, func(dir string) error {
			_, e := readJSON(connectionRecordPath(dir, recoveryRecordKey(n.runtime.config.Endpoint, id)), &row)
			return e
		})
		if e != nil || row == nil {
			return nil, connectionFailure("identity_recovery_material_unavailable")
		}
		if row["kind"] == "set-recovery" {
			if row["subjectId"] != scope.Owner || !connectionEqual(row["scope"], identityClone(scope)) {
				return nil, connectionFailure("native_choice_binding_changed")
			}
			if row["state"] == "registered" {
				stage = "done"
			} else {
				stage = "set-save"
			}
		} else if row["kind"] == "recover" {
			if !(scope.Owner == row["subjectId"] && scope.DeviceID == row["deviceId"]) && !connectionEqual(row["originalScope"], identityClone(scope)) {
				return nil, connectionFailure("native_choice_binding_changed")
			}
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
	b.recoveryEntries[path] = &recoveryBrowserEntry{expires: b.now().Add(10 * time.Minute), scope: scope, service: n, stage: stage, id: id, candidates: candidates}
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
		case page.stage == "no-pending" && action == "start-recovery" && len(form) == 1:
			page.stage, page.id = "recover", uuid.NewString()
		case page.stage == "select" && action == "select" && len(form) == 2 && len(form["selection"]) == 1:
			selected := form.Get("selection")
			candidates, err := recoveryCandidates(r.Context(), page.service, page.scope)
			if err != nil {
				page.message = "暂时无法读取待续恢复，请稍后重试。"
				break
			}
			found := false
			for _, candidate := range candidates {
				if candidate.ID == selected {
					found = true
					page.id = selected
					if strings.HasPrefix(candidate.Label, "设置") {
						page.stage = "set-save"
					} else if strings.Contains(candidate.Label, "保存") {
						page.stage = "recover-save"
					} else {
						page.stage = "recover-reconcile"
					}
					break
				}
			}
			if !found {
				page.candidates = candidates
				if len(candidates) == 0 {
					page.stage = "no-pending"
				}
				page.message = "该恢复项目已变化，请重新选择。"
			}
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
				page.message = "恢复尚需继续，请确认是否继续。"
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
				if result != nil && text(result["operationId"]) != "" {
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
			// Reconciliation runs below and does not resend the original operation.
		case page.stage == "recover-save" && action == "saved" && len(form) == 1:
			result, e := page.service.ConfirmNextSaved(r.Context(), page.id, &page.scope)
			if e != nil {
				page.message = "保存声明结果暂不明；请再次核对原操作，不会自动重发。"
			} else if uploadObject(result["receipt"])["state"] == "committed" {
				page.stage = "done"
				page.message = "恢复及保存声明已完成；连接需要另行确认。"
			} else if uploadObject(result["receipt"])["state"] == "requested" {
				page.stage = "declaration-retry"
				page.message = "保存确认尚需继续，请确认是否继续。"
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
	if page.stage == "recover-reconcile" {
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
			page.message = "恢复尚需继续，请确认是否继续。"
		} else if result["state"] == "not-dispatched" {
			page.stage = "recover"
			page.id = uuid.NewString()
			page.message = "此次恢复尚未提交；可重新输入恢复码。"
		} else {
			page.message = "原操作尚未确认；没有重新提交。"
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
	data := struct {
		Path, Stage, Message, Code string
		Candidates                 []recoveryCandidate
	}{r.URL.Path, page.stage, page.message, code, page.candidates}
	if e := recoveryPageTemplate.Execute(&output, data); e != nil {
		recoveryReply(w, 500, "恢复页面暂不可用。")
		return
	}
	recoveryReply(w, 200, output.String())
}

var recoveryPageTemplate = template.Must(template.New("identity-recovery").Parse(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>银河 · 身份恢复</title><style>body{font:16px/1.6 system-ui;max-width:680px;margin:36px auto;padding:0 18px}textarea,code{width:100%;overflow-wrap:anywhere}button{font:inherit;padding:10px 18px;margin:8px 8px 0 0}.secret{padding:16px;border:1px solid #777;user-select:all}</style><h1>银河身份恢复</h1>{{if .Message}}<p>{{.Message}}</p>{{end}}{{if eq .Stage "no-pending"}}<p>当前没有可继续的恢复。可以开始恢复身份。</p><form method="post" action="{{.Path}}"><button name="action" value="start-recovery">开始恢复身份</button></form>{{else if eq .Stage "select"}}<p>请选择要继续的恢复：</p>{{range .Candidates}}<form method="post" action="{{$.Path}}"><p>身份：{{.Subject}} · {{.Label}} · {{.When}}</p><input type="hidden" name="selection" value="{{.ID}}"><button name="action" value="select">继续此恢复</button></form>{{end}}{{else if eq .Stage "set"}}<p>为当前身份准备新的恢复码。请亲自保存；确认保存后才登记，之前的恢复码将被替换。</p><form method="post" action="{{.Path}}"><button name="action" value="prepare">准备恢复码</button></form>{{else if eq .Stage "recover"}}<p>仅在本机输入原恢复码。恢复将保留原身份，撤销此服务上原设备与绑定，并生成新的恢复码。资料恢复和重新连接分别确认。</p><form method="post" action="{{.Path}}"><label for="code">原恢复码</label><textarea id="code" name="code" required autocomplete="off" spellcheck="false" rows="4"></textarea><button name="action" value="recover">本人确认恢复此身份</button></form>{{else if or (eq .Stage "set-save") (eq .Stage "recover-save")}}<p>请在自己的安全位置保存此恢复码。不要发送给助手或其他人。它只显示在本机页面。</p>{{if .Code}}<p class="secret"><code>{{.Code}}</code></p><form method="post" action="{{.Path}}"><button name="action" value="saved">本人已保存此恢复码</button></form>{{end}}{{else if or (eq .Stage "set-retry") (eq .Stage "recover-retry") (eq .Stage "declaration-retry")}}<p>已核对服务记录，此操作仍需继续。确认后将继续原来的恢复。</p><form method="post" action="{{.Path}}"><button name="action" value="retry">本人确认继续</button></form>{{else if eq .Stage "recover-reconcile"}}<p>暂时无法确认恢复进度，请稍后再次检查。</p><form method="post" action="{{.Path}}"><button name="action" value="reconcile">重新检查</button></form>{{else}}<p>可关闭此页面。</p>{{end}}</html>`))

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
