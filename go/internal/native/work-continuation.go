package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"regexp"
	"strings"
)

type WorkContinuationReader struct{ runtime *Runtime }

func NewWorkContinuationReader(r *Runtime) *WorkContinuationReader {
	return &WorkContinuationReader{runtime: r}
}
func continuationReason(e error) string {
	code := fault.Code(e)
	if isOne(code, "access_denied", "binding_revoked", "invalid_session", "session_expired", "unauthorized", "receipt_status_authority_changed", "native_connection_selection_changed", "native_runtime_closed") {
		return "connection-changed"
	}
	switch fault.Status(e) {
	case 403:
		return "not-permitted"
	case 404:
		return "source-unavailable"
	case 410:
		return "source-expired"
	}
	return "temporarily-unavailable"
}
func continuationRead(ctx context.Context, l *nativeIdentityLease, object map[string]any) (map[string]any, error) {
	id := text(object["id"])
	switch object["kind"] {
	case "task":
		return l.call(ctx, "/v2/tasks/"+id, nil, false)
	case "room":
		return l.call(ctx, "/v2/chat/rooms/"+id+"/read", map[string]any{}, false)
	case "project":
		return l.call(ctx, "/v2/projects/"+id, nil, false)
	case "person":
		return l.call(ctx, "/v1/history/query", map[string]any{"subjectId": id, "limit": 1}, false)
	case "post":
		path := "/v2/community/posts/" + id
		if object["versionId"] != nil {
			path += "/versions/" + text(object["versionId"])
		}
		return l.call(ctx, path, nil, false)
	case "capsule":
		return l.call(ctx, "/v2/capsules/read", map[string]any{"capsuleId": id, "versionId": object["versionId"]}, false)
	case "context":
		return l.call(ctx, "/v2/context/"+id, nil, false)
	}
	return nil, connectionFailure("work_continuation_source_mismatch")
}
func continuationWorkResults(ctx context.Context, l *nativeIdentityLease, task map[string]any) (map[string]any, error) {
	if task["caseId"] == nil {
		return map[string]any{"state": "not-recorded", "results": []any{}}, nil
	}
	view, e := l.call(ctx, "/v2/cases/"+text(task["caseId"])+"/read", map[string]any{"taskId": task["taskId"]}, false)
	if e != nil {
		if changed := l.check(ctx); changed != nil {
			return nil, changed
		}
		reason := continuationReason(e)
		if reason == "connection-changed" {
			return nil, connectionFailure("work_continuation_connection_changed")
		}
		return map[string]any{"state": "unavailable", "reason": reason, "results": []any{}}, nil
	}
	if view["caseId"] != task["caseId"] {
		return nil, connectionFailure("work_continuation_source_mismatch")
	}
	results := []any{}
	for _, raw := range uploadRows(view["results"]) {
		results = append(results, continuationPick(uploadObject(raw), "id", "version", "actorId", "participationId", "scopeVersion", "origin", "summary", "reportedOutcome", "limitations", "deliverableRefs"))
	}
	var resolution any
	if view["resolution"] != nil {
		resolution = continuationPick(uploadObject(view["resolution"]), "id", "status", "scopeVersion", "summary", "remainingGoals", "resultRefs", "reconfirmationRequired", "currentDecisionAvailable")
	}
	return map[string]any{"state": "current", "caseId": view["caseId"], "version": view["version"], "scopeVersion": view["scopeVersion"], "results": results, "resolution": resolution, "coverage": continuationPick(uploadObject(view["coverage"]), "complete", "reasons")}, nil
}
func continuationTaskResultsText(task, work map[string]any) string {
	output := []string{}
	if work["state"] == "current" {
		for _, raw := range uploadRows(work["results"]) {
			r := uploadObject(raw)
			label := continuationOutcomes[text(r["reportedOutcome"])]
			if label == "" {
				label = "原作者的结果说明"
			}
			if line := continuationLines("已有工作结果 · "+label, continuationText(r["summary"]), continuationText(r["limitations"])); line != "" {
				output = append(output, line)
			}
		}
	}
	deliveries := 0
	for _, raw := range uploadRows(task["participations"]) {
		p := uploadObject(raw)
		for _, raw := range uploadRows(p["deliveries"]) {
			d := uploadObject(raw)
			summary := continuationText(d["summary"])
			if summary == "" {
				continue
			}
			deliveries++
			heading := "已经提交的交付说明"
			if d["acceptance"] != nil {
				heading = "已经接收的交付说明"
			}
			output = append(output, continuationLines(heading, summary))
		}
	}
	if work["state"] == "unavailable" {
		output = append(output, "已有工作结果目前无法核对，保持未知；不能据此判断工作没有结果。")
	} else if len(uploadRows(work["results"])) == 0 && deliveries == 0 {
		output = append(output, "目前没有读到已记录的结果。希望取得的结果仍是目标，不是完成事实。")
	}
	return strings.Join(output, "\n\n")
}
func (c *WorkContinuationReader) Read(ctx context.Context, link string) (map[string]any, error) {
	request, e := readContinuationLink(link)
	if e != nil {
		return nil, e
	}
	if request["website"] != c.runtime.config.Website || request["endpoint"] != c.runtime.config.Endpoint {
		return nil, connectionFailure("work_continuation_service_mismatch")
	}
	status, e := c.runtime.Status(ctx, RuntimeStatusOptions{RestoreSelected: true})
	if e != nil {
		return nil, e
	}
	if status["identity"] != request["subjectId"] {
		return nil, connectionFailure("work_continuation_identity_mismatch")
	}
	if status["connected"] != true {
		return nil, connectionFailure("work_continuation_connection_required")
	}
	ctx, cancel, l, e := c.runtime.identityLease(ctx, true)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if l.scope.Owner != request["subjectId"] {
		return nil, connectionFailure("work_continuation_identity_mismatch")
	}
	refs := append([]any{request["object"]}, uploadRows(request["selectedMaterials"])...)
	seen := map[string]bool{}
	sources := []any{}
	for _, raw := range refs {
		ref := uploadObject(raw)
		key := hostJSONString(ref)
		if seen[key] {
			continue
		}
		seen[key] = true
		if e = l.check(ctx); e != nil {
			return nil, e
		}
		data, readErr := continuationRead(ctx, l, ref)
		var reading *continuationReading
		var machine any
		var reason any
		if readErr == nil {
			reading, readErr = sourceContinuationReading(ref, data)
			if readErr == nil {
				if reading == nil {
					reason = "source-unavailable"
					if isOne(text(data["state"]), "expired", "source-expired") || isOne(text(data["availability"]), "expired", "source-expired") {
						reason = "source-expired"
					}
				} else {
					projection := continuationSourceData(ref, data)
					machine = projection
					if ref["kind"] == "task" {
						work, e := continuationWorkResults(ctx, l, data)
						if e != nil {
							readErr = e
						} else {
							reading.content = continuationJoin(reading.content, continuationTaskResultsText(data, work))
							projection["workResults"] = work
						}
					}
				}
			}
		}
		if readErr != nil {
			if e = l.check(ctx); e != nil {
				return nil, e
			}
			if fault.Code(readErr) == "work_continuation_source_mismatch" {
				return nil, readErr
			}
			reason = continuationReason(readErr)
			if reason == "connection-changed" {
				return nil, connectionFailure("work_continuation_connection_changed")
			}
		}
		role := "selected"
		if len(sources) == 0 {
			role = "current"
		}
		var sourceURL any
		if path := continuationPath(ref); path != "" {
			sourceURL = c.runtime.config.Website + path
		}
		item := map[string]any{"role": role, "object": ref, "url": sourceURL, "state": "unavailable", "reason": reason, "title": nil, "content": nil, "notes": []any{}, "availableUntil": nil, "deadlineReason": "source-expired", "data": machine}
		if reading != nil {
			item["state"] = "available"
			item["title"] = reading.title
			item["content"] = reading.content
			item["notes"] = reading.notes
			item["availableUntil"] = reading.until
			item["deadlineReason"] = reading.deadline
		}
		sources = append(sources, item)
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	now := c.runtime.connection.now().Unix()
	for _, raw := range sources {
		source := uploadObject(raw)
		if source["availableUntil"] != nil {
			if until, ok := continuationNumber(source["availableUntil"], true); ok && until <= float64(now) {
				source["state"] = "unavailable"
				source["reason"] = source["deadlineReason"]
				source["title"] = nil
				source["content"] = nil
				source["notes"] = []any{}
				source["data"] = nil
			}
		}
	}
	return map[string]any{"kind": "galaxy-work-continuation", "purpose": request["purpose"], "subjectId": l.scope.Owner, "endpoint": l.scope.Endpoint, "sources": sources, "returnUrl": request["returnUrl"], "currentSourceUrl": request["sourceUrl"], "checkedAt": now, "availableActions": []any{map[string]any{"kind": "return-to-page", "label": "回到原页面继续", "url": request["returnUrl"]}}, "permissionExpanded": false, "businessMutation": false, "modelStarted": false, "reuseOutcomeRecorded": false}, nil
}
func WorkContinuationResultText(data map[string]any) string {
	reasons := map[string]string{"not-permitted": "当前身份不能读取这份资料。", "source-unavailable": "这份资料目前不可读。", "source-expired": "这份资料的可读期限已结束。", "temporarily-unavailable": "暂时无法核对这份资料，连接恢复后可以继续。"}
	output := []string{continuationLines("接着当前事情", continuationText(data["purpose"]))}
	for _, raw := range uploadRows(data["sources"]) {
		s := uploadObject(raw)
		if s["state"] == "available" {
			heading := "所选资料："
			if s["role"] == "current" {
				heading = "当前内容："
			}
			values := []string{text(s["content"])}
			values = append(values, continuationStrings(s["notes"])...)
			if text(s["url"]) != "" {
				values = append(values, "来源："+text(s["url"]))
			}
			output = append(output, continuationLines(heading+text(s["title"]), values...))
		} else {
			heading := "所选资料"
			if s["role"] == "current" {
				heading = "当前内容"
			}
			reason := reasons[text(s["reason"])]
			if reason == "" {
				reason = reasons["source-unavailable"]
			}
			output = append(output, heading+"："+reason)
		}
	}
	output = append(output, "继续处理：围绕上面的目的整理可用内容与下一步；尚未取得的材料和结果保持未知。", "回到原页面继续：\n"+text(data["returnUrl"]))
	return continuationJoin(output...)
}

var continuationError = regexp.MustCompile(`^work_continuation_[a-z_]+$`)

func registerWorkContinuationTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	reader := NewWorkContinuationReader(runtime)
	contract := uploadObject(workPurposeContracts()["galaxy_work_continue"])
	addNativeTool(server, &mcp.Tool{Name: "galaxy_work_continue", Description: text(contract["description"]), InputSchema: contract["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "work_continuation_link_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		input, e := connectionObject(req.Params.Arguments)
		var data map[string]any
		if e == nil {
			data, e = reader.Read(ctx, text(input["link"]))
		}
		if e != nil {
			code := fault.Code(e)
			if !continuationError.MatchString(code) {
				code = "work_continuation_unavailable"
			}
			message := "暂时无法接回这份内容。原页面和选择保留，恢复当前连接后可以继续同一链接。"
			if code == "work_continuation_identity_mismatch" {
				message = "当前客户端使用的身份与网页选择不同。请回到原身份继续；没有读取所选正文。"
			} else if code == "work_continuation_service_mismatch" {
				message = "这个链接不属于当前选定的银河服务。请在对应服务继续；没有读取所选正文。"
			}
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}, StructuredContent: map[string]any{"error": code, "bodyDisclosed": false, "permissionExpanded": false, "businessMutation": false}}, nil
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: WorkContinuationResultText(data)}}, StructuredContent: data}, nil
	})
}
