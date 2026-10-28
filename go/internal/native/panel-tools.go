package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
	"strings"
)

func nativeCompactUIAdvertised(req *mcp.CallToolRequest) bool {
	if req == nil {
		return false
	}
	raw, e := protocol.Encode(req.ClientCapabilities())
	if e != nil {
		return false
	}
	var capabilities panelMap
	if protocol.Decode(raw, &capabilities) != nil {
		return false
	}
	ui := psObject(psObject(capabilities["extensions"])["io.modelcontextprotocol/ui"])
	for _, v := range trustArray(ui["mimeTypes"]) {
		if v == InteractionAppMIME {
			return true
		}
	}
	return false
}
func panelToolResult(data panelMap, req *mcp.CallToolRequest) *mcp.CallToolResult {
	model := panelPick(data)
	for k, v := range data {
		model[k] = v
	}
	component := panelMap{}
	for _, key := range []string{"draft", "replyDraft", "preview", "choice"} {
		if value, ok := data[key]; ok && value != nil {
			component[key] = value
			delete(model, key)
			row := psObject(value)
			switch key {
			case "draft", "replyDraft":
				model[key] = panelMap{"revision": row["revision"], "scope": row["scope"], "hasContent": panelNonempty(row["text"])}
			case "preview":
				preview := panelPick(row, "operationId", "payloadHash", "authorizationRequestId", "authorizationExpiresAt", "kind", "taskId", "recipientIds", "visibility", "state")
				preview["exactContentInComponent"] = true
				model[key] = preview
			case "choice":
				choice := panelPick(row, "state", "operation")
				choice["sideEffect"] = false
				model[key] = choice
			}
		}
	}
	host := panelMap{}
	if req != nil {
		host = panelMap{"advertisedByHost": nativeCompactUIAdvertised(req), "actualRendering": "not-confirmed"}
	}
	meta := mcp.Meta{"galaxyUi": host}
	if len(component) > 0 {
		meta["galaxyPanel"] = component
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: panelPresentation(model)}}, StructuredContent: model, Meta: meta}
}
func panelToolError(e error, hostView bool) *mcp.CallToolResult {
	code := panelCode(e)
	if code == "panel_source_unavailable" {
		code = "panel_operation_failed"
	}
	if hostView && code == "panel_operation_failed" {
		code = "host_view_unavailable"
	}
	data := panelMap{"error": code, "businessMutation": false}
	if hostView {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{}, StructuredContent: data}
	}
	result := panelToolResult(data, nil)
	result.IsError = true
	return result
}
func panelOutcome(result *mcp.CallToolResult) (panelMap, bool, error) {
	if result == nil {
		return nil, false, panelError("panel_action_review_failed")
	}
	raw, e := protocol.Encode(result)
	if e != nil {
		return nil, false, e
	}
	decoded, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, false, e
	}
	if psObject(decoded)["resultType"] == "input_required" {
		return nil, true, nil
	}
	if result.IsError || len(result.Content) != 1 {
		return nil, false, panelError("panel_action_review_failed")
	}
	body, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		return nil, false, panelError("panel_action_review_failed")
	}
	if result.StructuredContent != nil {
		raw, e = protocol.Encode(result.StructuredContent)
		if e != nil {
			return nil, false, e
		}
		value, e := jstext.DecodeJSON(raw)
		return psObject(value), false, e
	}
	value, e := jstext.DecodeJSON([]byte(body.Text))
	return psObject(value), false, e
}
func (p *NativePanel) executeTool(ctx context.Context, req *mcp.CallToolRequest, tools *toolRuntime, x panelMap) (*mcp.CallToolResult, error) {
	operation, cancel, l, e := p.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	ctx = operation
	v, e := l.required(ctx, text(x["viewId"]))
	if e != nil {
		return nil, e
	}
	session, e := l.helpView(v)
	if e != nil {
		return nil, e
	}
	preview, e := l.helpCall(ctx, "galaxy_help_action_preview", panelMap{"sessionId": session, "operationId": x["operationId"]})
	if e != nil {
		return nil, e
	}
	if preview["payloadHash"] != x["payloadHash"] {
		return nil, panelError("help_action_preview_changed")
	}
	if auth := x["authorizationRequestId"]; auth != nil && auth != preview["authorizationRequestId"] {
		return nil, panelError("help_authorization_preview_changed")
	}
	input := panelPick(x, "operationId", "payloadHash", "authorizationRequestId")
	run := func(scope *ChoiceScope) (any, error) {
		if scope != nil && *scope != l.scope {
			return nil, panelError("panel_identity_changed")
		}
		if e := l.check(ctx); e != nil {
			return nil, e
		}
		helpLease, e := p.Help.begin(ctx)
		if e != nil {
			return nil, e
		}
		if helpLease.scope != l.scope {
			return nil, panelError("panel_connection_changed")
		}
		out, e := helpLease.executeAction(ctx, session, input, scope)
		if check := l.check(ctx); check != nil {
			return nil, check
		}
		return out, e
	}
	var outcome panelMap
	if isOne(text(preview["state"]), "prepared", "absent") {
		if tools == nil {
			return nil, panelError("panel_action_review_required")
		}
		readable, e := l.readablePreview(ctx, v, preview)
		if e != nil {
			return nil, e
		}
		review := psObject(psClone(x))
		review["preview"] = readable
		result, e := tools.review(ctx, req, review, "Execute the explicitly confirmed exact preview through existing authorization and business services. Unknown outcomes require the original receipt query; never retries blindly.", run)
		if e != nil {
			return nil, e
		}
		var pending bool
		outcome, pending, e = panelOutcome(result)
		if e != nil {
			return nil, e
		}
		if pending {
			return result, nil
		}
	} else {
		value, e := run(nil)
		if e != nil {
			return nil, e
		}
		outcome = psObject(value)
	}
	if isOne(text(outcome["state"]), "declined", "user-choice-needs-browser") {
		choice := psObject(psClone(outcome))
		delete(choice, "preview")
		rendered, e := l.render(ctx, v)
		if e != nil {
			return nil, e
		}
		if outcome["state"] == "user-choice-needs-browser" {
			readable, e := l.readablePreview(ctx, v, preview)
			if e != nil {
				return nil, e
			}
			rendered["preview"] = readable
		}
		rendered["choice"] = choice
		rendered["actionResult"] = panelMap{"operationId": x["operationId"], "state": outcome["state"], "receipt": nil, "successFactsCreated": false}
		return panelToolResult(rendered, req), nil
	}
	rendered, e := l.render(ctx, v)
	if e != nil {
		return nil, e
	}
	result := panelActionResult(outcome, x["operationId"])
	for _, raw := range trustArray(psObject(rendered["help"])["actionOperations"]) {
		record := psObject(raw)
		if record["operationId"] == x["operationId"] {
			result["state"] = record["state"]
			break
		}
	}
	rendered["actionResult"] = result
	return panelToolResult(rendered, req), nil
}

// Resource registration remains with the Runtime factory. This registration
// shares exactly its Help and Navigation instances and closes only these views.
func registerNativePanelTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime, help *NativeHelp, navigation *NativeNavigation, artifact *InteractionArtifact) func() {
	if artifact == nil {
		return func() {}
	}
	panel := NewNativePanel(runtime, help, navigation)
	descriptions := map[string]string{"galaxy_panel": "Show concrete user-model help explanations only after current source review, actual responses separately, and matching/publishing/participation entries. Device-local unsent notes are component-only metadata. Text-only hosts retain object references and use ordinary help/task tools.", "galaxy_panel_refresh": "Re-read only this view’s current object through existing permissions. Does not mark human read.", "galaxy_panel_open": "Open this exact object or one of three active entries in the configured browser. Does not publish or join.", "galaxy_panel_return": "Refresh this view’s own original browser navigation. Does not cancel or complete work.", "galaxy_panel_draft_save": "Save only this view’s device-local draft with revision conflict protection. No sharing or cloud synchronization.", "galaxy_panel_reply_draft_save": "Keep this current conversation’s unsent reply on this device only. Text stays in component metadata and is never model context or a shared message.", "galaxy_panel_message_send": "Send the panel user’s exact reply within an existing current respond grant. Preserve the original clientMessageId after unknown delivery; reconcile automatically before another send.", "galaxy_panel_select": "Save this exact set of help IDs as a device-local choice after source review. Does not contact, publish, apply or pay.", "galaxy_panel_action_prepare": "Prepare a precise existing help-flow action for component review. Includes exact material, recipients and visibility. No business submission or automatic authorization.", "galaxy_panel_action_preview": "Recover the exact pending action preview by its original operation ID. Never reconstructs a new operation.", "galaxy_panel_action_execute": "Execute the explicitly confirmed exact preview through existing authorization and business services. Unknown outcomes require the original receipt query; never retries blindly.", "galaxy_panel_action_reconcile": "Query the original operation receipt without resending or changing IDs, recipients or material.", "galaxy_panel_finish": "Refresh actual task state and return minimal references to the original work. Does not cancel remote work, claim resolution or automatically invoke a model.", "galaxy_host_view_state": "Read or save only device-local host display preferences for the current principal and endpoint. No cloud or business effects."}
	contracts := panelContracts()
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		write := isOne(name, "galaxy_panel_open", "galaxy_panel_draft_save", "galaxy_panel_reply_draft_save", "galaxy_panel_message_send", "galaxy_panel_select", "galaxy_panel_action_prepare", "galaxy_panel_action_execute", "galaxy_panel_finish", "galaxy_host_view_state")
		appOnly := isOne(name, "galaxy_panel_reply_draft_save", "galaxy_panel_message_send", "galaxy_host_view_state")
		destructive := false
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contracts[name], Description: descriptions[name], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write, DestructiveHint: &destructive}, Meta: InteractionToolMeta(artifact.URI, appOnly)}, "panel_operation_failed", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			decoded, e := jstext.DecodeJSON(req.Params.Arguments)
			if e != nil {
				return panelToolError(e, name == "galaxy_host_view_state"), nil
			}
			input, e := panelInput(name, decoded)
			if e != nil {
				return panelToolError(e, name == "galaxy_host_view_state"), nil
			}
			if name == "galaxy_panel_action_execute" {
				out, e := panel.executeTool(ctx, req, tools, input)
				if e != nil {
					return panelToolError(e, false), nil
				}
				return out, nil
			}
			data, e := panel.Call(ctx, name, input)
			if e != nil {
				return panelToolError(e, name == "galaxy_host_view_state"), nil
			}
			if name == "galaxy_host_view_state" {
				return &mcp.CallToolResult{Content: []mcp.Content{}, StructuredContent: data}, nil
			}
			return panelToolResult(data, req), nil
		})
	}
	return panel.Close
}

func panelPresentation(data panelMap) string {
	if data["error"] != nil {
		return "当前内容暂时无法取得。保留原输入，稍后重试或继续原工作。"
	}
	if data["url"] != nil && data["schemaVersion"] == nil {
		prefix := "可以打开当前内容："
		if data["launched"] == true {
			prefix = "已请求打开当前内容。"
		}
		return prefix + "\n" + text(data["url"])
	}
	if data["draft"] != nil && data["schemaVersion"] == nil {
		return "笔记已保存在本机。"
	}
	lines := []string{}
	add := func(v any) {
		if panelNonempty(v) {
			switch value := v.(type) {
			case string:
				lines = append(lines, value)
			case jstext.String:
				lines = append(lines, value.Decoded())
			}
		}
	}
	if data["sourceError"] != nil || data["helpError"] != nil {
		add("部分内容暂不可用，请继续原工作或稍后重试。")
	}
	source := psObject(data["source"])
	if source != nil {
		add(panelDefault(source["title"], "当前工作"))
		add(source["summary"])
		method := psObject(source["method"])
		if panelNonempty(method["solutionStrategy"]) {
			add(method["problemPattern"])
			add("解决方法：" + text(method["solutionStrategy"]))
			if panelNonempty(method["applicableScope"]) {
				add("适用范围：" + text(method["applicableScope"]))
			}
			limitations := helpStrings(method["limitations"])
			if len(limitations) > 0 {
				add("限制：" + strings.Join(limitations, "；"))
			}
		}
		messages := trustArray(psObject(source["conversation"])["messages"])
		if len(messages) > 0 {
			add("当前已读取的消息：")
			if len(messages) > 5 {
				messages = messages[len(messages)-5:]
			}
			for _, v := range messages {
				m := psObject(v)
				add(text(panelDefault(m["authorLabel"], "成员")) + "：" + text(panelDefault(m["text"], "这条消息已撤回。")))
			}
		}
	}
	count := 0
	for _, v := range trustArray(psObject(data["help"])["offers"]) {
		offer := psObject(v)
		if offer["state"] == "current" && count < 4 {
			count++
			add(offer["helpDescription"])
			add(offer["userFacingReason"])
		}
	}
	if preview := psObject(data["preview"]); preview != nil {
		label := map[string]string{"publish-task": "发布请求", "task-event": "更新请求", "participation-propose": "申请参与", "participation-event": "更新参与情况", "context-grant": "分享材料", "context-event": "调整材料范围"}[text(preview["kind"])]
		if label == "" {
			label = "本次操作"
		}
		add("已准备" + label + "，请查看内容与范围。")
	}
	operationLabel := func(v any) string {
		label := map[string]string{"prepared": "待发送", "absent": "尚未发送", "submitting": "正在发送", "unknown": "正在确认是否发送", "acknowledged": "已完成", "conflict": "内容发生变化", "declined": "已取消", "accepted": "已发送", "proposed": "已申请", "revoked": "已撤销", "active": "进行中", "open": "进行中", "closed": "已结束", "pending": "正在发送", "retracted": "已撤回", "expired": "已过期", "available": "可使用"}[text(v)]
		if label == "" {
			return "已更新"
		}
		return label
	}
	if result := psObject(data["actionResult"]); result != nil {
		add(operationLabel(result["state"]))
	}
	if result := psObject(data["messageResult"]); result != nil {
		if result["state"] == "accepted" {
			add("消息已发送。")
		} else {
			add(operationLabel(result["state"]))
		}
	}
	if data["handoff"] != nil {
		add("可以带着当前结果继续原工作。")
	}
	if len(lines) == 0 {
		return "在原工作中说明想取得的帮助，银河将沿用已有内容和身份继续。"
	}
	return strings.Join(lines, "\n\n")
}
