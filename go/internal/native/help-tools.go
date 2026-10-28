package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

func helpTrim(v any) any {
	switch s := v.(type) {
	case string:
		units := jstext.From(s).Trim()
		if units.HasUnpaired() {
			return units
		}
		return units.Decoded()
	case jstext.String:
		return s.Trim()
	}
	return v
}
func helpInput(name string, input any) (map[string]any, error) {
	values, e := trustJSON(input)
	if e != nil {
		return nil, e
	}
	if name == "galaxy_help_start" {
		values["localTaskRef"] = helpTrim(values["localTaskRef"])
	}
	if name == "galaxy_help_compose" {
		for _, v := range trustArray(values["offers"]) {
			o := psObject(v)
			for _, k := range []string{"helpDescription", "userFacingReason"} {
				o[k] = helpTrim(o[k])
			}
			for _, k := range []string{"environmentDifferences", "conditions"} {
				a := trustArray(o[k])
				for i, v := range a {
					a[i] = helpTrim(v)
				}
			}
		}
	}
	values, e = remoteReputationInput(psObject(helpContracts()["contracts"]), name, values)
	if e != nil {
		return nil, e
	}
	key, field := "", ""
	switch name {
	case "galaxy_help_query":
		key, field = "requestId", "requests"
	case "galaxy_help_compose":
		key, field = "id", "offers"
	}
	if key != "" {
		seen := map[string]bool{}
		for _, v := range trustArray(values[field]) {
			id := text(psObject(v)[key])
			if seen[id] {
				return nil, helpError("help_operation_failed")
			}
			seen[id] = true
		}
	}
	if name == "galaxy_help_select" {
		seen := map[string]bool{}
		for _, id := range helpStrings(values["offerIds"]) {
			if seen[id] {
				return nil, helpError("help_operation_failed")
			}
			seen[id] = true
		}
	}
	return values, nil
}
func helpToolError(e error) (*mcp.CallToolResult, error) {
	code := runtimeErrorCode(e)
	recovery := psObject(helpContracts()["recovery"])
	message := recovery[code]
	if message == nil {
		code = "help_operation_failed"
		message = "reread-local-session-and-original-receipt-before-retrying-writes"
	}
	result, encoding := toolResult(map[string]any{"error": code, "recovery": message, "automaticRetryAuthorized": false, "remoteOperationsCanceled": false})
	if result != nil {
		result.IsError = true
	}
	return result, encoding
}
func (h *NativeHelp) Call(ctx context.Context, name string, input any) (any, error) {
	values, e := helpInput(name, input)
	if e != nil {
		return nil, e
	}
	l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	id := text(values["sessionId"])
	switch name {
	case "galaxy_help_start":
		row, e := l.create(ctx, values)
		if e != nil {
			return nil, e
		}
		return helpView(row), nil
	case "galaxy_help_get":
		row, e := l.get(ctx, id)
		if e != nil {
			return nil, e
		}
		return helpView(row), nil
	case "galaxy_help_query":
		return l.query(ctx, id, values)
	case "galaxy_help_compose":
		return l.compose(ctx, id, values)
	case "galaxy_help_select":
		return l.selectOffers(ctx, id, values)
	case "galaxy_help_pause":
		row, e := l.update(ctx, id, values["expectedRevision"], func(row map[string]any) error { row["pauseState"] = values["state"]; return nil })
		if e != nil {
			return nil, e
		}
		return helpView(row), nil
	case "galaxy_help_publish":
		return l.publish(ctx, id, map[string]any{"consentId": values["consentId"], "payloadJson": values["payloadJson"]})
	case "galaxy_help_reconcile":
		return l.reconcile(ctx, id, text(values["operationId"]))
	case "galaxy_help_refresh":
		return l.refresh(ctx, id)
	case "galaxy_help_return":
		row, e := l.get(ctx, id)
		if e != nil {
			return nil, e
		}
		if psInt(row["revision"]) != psInt(values["expectedRevision"]) {
			return nil, helpError("help_session_changed")
		}
		result, e := l.refresh(ctx, id)
		if e != nil {
			return nil, e
		}
		row, e = l.update(ctx, id, psObject(result["session"])["revision"], func(row map[string]any) error { row["pauseState"] = "returned"; return nil })
		if e != nil {
			return nil, e
		}
		refs := []any{}
		for _, v := range trustArray(row["linkedOperations"]) {
			r := psObject(v)
			refs = append(refs, map[string]any{"operationId": r["operationId"], "taskId": r["taskId"], "state": r["state"]})
		}
		result["session"] = helpView(row)
		result["handoff"] = map[string]any{"localTaskRef": row["localTaskRef"], "caseId": row["caseId"], "taskId": row["taskId"], "operationRefs": refs, "actionOperationRefs": row["actionOperations"], "method": "original-conversation-and-mcp-refresh", "hostCallbackVerified": false}
		result["remoteOperationsCanceled"] = false
		result["successFactsCreated"] = false
		result["userMustDecideExistingCommitments"] = true
		return result, nil
	case "galaxy_help_forget":
		return l.forget(ctx, id)
	case "galaxy_help_review":
		return l.review(ctx, id)
	case "galaxy_help_prepare_action":
		body := psObject(psClone(values))
		delete(body, "sessionId")
		return l.prepareAction(ctx, id, body)
	case "galaxy_help_action_preview":
		row, e := l.operation(ctx, id, text(values["operationId"]), nil)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return nil, helpError("help_action_unavailable")
		}
		return helpActionPreview(row), nil
	case "galaxy_help_reconcile_action":
		return l.reconcileAction(ctx, id, text(values["operationId"]))
	case "galaxy_help_execute_action":
		return l.executeAction(ctx, id, values, nil)
	}
	return nil, helpError("help_operation_failed")
}
func registerNativeHelpTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) func() {
	runtime.mu.Lock()
	host := runtime.nativeHelp
	if host != nil {
		host.mu.Lock()
		closed := host.closed
		host.mu.Unlock()
		if closed {
			host = nil
		}
	}
	if host == nil {
		host = NewNativeHelp(runtime)
		runtime.nativeHelp = host
	}
	runtime.mu.Unlock()
	contracts := psObject(helpContracts()["contracts"])
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := psObject(contracts[name])
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: contract["readOnlyHint"] == true, DestructiveHint: func() *bool { b := contract["destructiveHint"] == true; return &b }(), OpenWorldHint: func() *bool { b := contract["openWorldHint"] == true; return &b }()}}, "help_operation_failed", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			decoded, e := jstext.DecodeJSON(req.Params.Arguments)
			if e != nil {
				return helpToolError(e)
			}
			input, e := helpInput(name, decoded)
			if e != nil {
				return helpToolError(e)
			}
			if name == "galaxy_help_execute_action" {
				l, e := host.begin(ctx)
				if e != nil {
					return helpToolError(e)
				}
				id := text(input["sessionId"])
				row, e := l.operation(ctx, id, text(input["operationId"]), nil)
				if e != nil {
					return helpToolError(e)
				}
				if row == nil {
					return helpToolError(helpError("help_action_unavailable"))
				}
				preview := helpActionPreview(row)
				if preview["payloadHash"] != input["payloadHash"] {
					return helpToolError(helpError("help_action_preview_changed"))
				}
				if !isOne(text(preview["state"]), "prepared", "absent") {
					out, e := l.executeAction(ctx, id, input, nil)
					if e != nil {
						return helpToolError(e)
					}
					return toolResult(out)
				}
				auth := input["authorizationRequestId"]
				if auth == nil {
					auth = input["operationId"]
				}
				if preview["authorizationRequestId"] != nil && auth != preview["authorizationRequestId"] {
					return helpToolError(helpError("help_authorization_preview_changed"))
				}
				// Original Native review enriches only a Task event's current title and
				// already referenced recipients' permitted self-declared display names.
				if preview["kind"] == "task-event" {
					task, e := l.task(ctx, text(preview["taskId"]))
					if e != nil {
						return helpToolError(e)
					}
					preview["title"] = psObject(task["request"])["title"]
					names := []any{}
					for _, subject := range helpStrings(preview["recipientIds"]) {
						page, _, e := l.call(ctx, "/v1/history/query", map[string]any{"subjectId": subject, "limit": 1})
						if e != nil {
							if check := l.check(ctx); check != nil {
								return helpToolError(check)
							}
							names = append(names, subject)
							continue
						}
						name := uploadTrim(text(psObject(page["selfDeclared"])["displayName"]))
						if name == "" {
							name = subject
						}
						names = append(names, name)
					}
					preview["recipientNames"] = names
				}
				review := psObject(psClone(input))
				review["preview"] = preview
				return tools.review(ctx, req, review, text(contract["description"]), func(scope *ChoiceScope) (any, error) {
					out, e := l.executeAction(ctx, id, input, scope)
					if e != nil {
						code := runtimeErrorCode(e)
						recovery := psObject(helpContracts()["recovery"])
						if recovery[code] == nil {
							code = "help_operation_failed"
						}
						return nil, helpError(code)
					}
					return out, nil
				})
			}
			out, e := host.Call(ctx, name, input)
			if e != nil {
				return helpToolError(e)
			}
			return toolResult(out)
		})
	}
	return host.Close
}
