package native

import "context"

func (l *panelLease) helpView(v *panelView) (string, error) {
	id := text(l.panel.viewInput(v)["helpSessionId"])
	if id == "" {
		return "", panelError("panel_help_session_required")
	}
	return id, nil
}
func (l *panelLease) readablePreview(ctx context.Context, v *panelView, preview panelMap) (panelMap, error) {
	names, e := l.profileLabels(ctx, helpStrings(preview["recipientIds"]))
	if e != nil {
		return nil, e
	}
	out := psObject(psClone(preview))
	labels := []any{}
	for _, id := range helpStrings(preview["recipientIds"]) {
		name := names[id]
		if name == nil {
			if id == v.owner {
				name = "自己"
			} else {
				name = "未公开名称的成员"
			}
		}
		labels = append(labels, name)
	}
	out["recipientNames"] = labels
	return out, nil
}
func panelActionResult(result panelMap, operation any) panelMap {
	state := result["state"]
	if state == nil {
		state = psObject(result["operation"])["state"]
	}
	if state == nil {
		state = psObject(result["action"])["state"]
	}
	if state == nil {
		state = psObject(result["receipt"])["state"]
	}
	if state == nil {
		state = "unknown"
	}
	receipt := result["receipt"]
	if receipt == nil {
		receipt = psObject(result["action"])["receipt"]
	}
	return panelMap{"operationId": operation, "state": state, "receipt": receipt, "successFactsCreated": false}
}
func (l *panelLease) helpOperation(ctx context.Context, v *panelView, name string, x panelMap) (panelMap, error) {
	session, e := l.helpView(v)
	if e != nil {
		return nil, e
	}
	input := panelMap{"sessionId": session}
	var result, preview panelMap
	switch name {
	case "galaxy_panel_select":
		review, e := l.helpCall(ctx, "galaxy_help_review", input)
		if e != nil {
			return nil, e
		}
		if psInt(psObject(review["session"])["revision"]) != psInt(x["expectedRevision"]) {
			return nil, panelError("help_session_changed")
		}
		for _, id := range helpStrings(x["offerIds"]) {
			found := false
			for _, raw := range trustArray(review["offers"]) {
				offer := psObject(raw)
				if offer["id"] == id && offer["state"] == "current" {
					found = true
					break
				}
			}
			if !found {
				return nil, panelError("help_selection_refresh_required")
			}
		}
		input["expectedRevision"], input["offerIds"] = x["expectedRevision"], x["offerIds"]
		if _, e = l.helpCall(ctx, "galaxy_help_select", input); e != nil {
			return nil, e
		}
	case "galaxy_panel_finish":
		input["expectedRevision"] = x["expectedRevision"]
		result, e = l.helpCall(ctx, "galaxy_help_return", input)
		if e != nil {
			return nil, e
		}
	case "galaxy_panel_action_prepare":
		for k, value := range psObject(x["action"]) {
			input[k] = value
		}
		preview, e = l.helpCall(ctx, "galaxy_help_prepare_action", input)
		if e != nil {
			return nil, e
		}
	case "galaxy_panel_action_preview":
		input["operationId"] = x["operationId"]
		preview, e = l.helpCall(ctx, "galaxy_help_action_preview", input)
		if e != nil {
			return nil, e
		}
	case "galaxy_panel_action_reconcile":
		input["operationId"] = x["operationId"]
		result, e = l.helpCall(ctx, "galaxy_help_reconcile_action", input)
		if e != nil {
			return nil, e
		}
	}
	out, e := l.render(ctx, v)
	if e != nil {
		return nil, e
	}
	if preview != nil {
		readable, e := l.readablePreview(ctx, v, preview)
		if e != nil {
			return nil, e
		}
		out["preview"] = readable
	}
	if name == "galaxy_panel_action_reconcile" {
		out["actionResult"] = panelActionResult(result, x["operationId"])
	}
	if name == "galaxy_panel_finish" {
		handoff := panelPick(psObject(result["handoff"]), "taskId", "caseId", "operationRefs", "method")
		handoff["sessionId"], handoff["hostCallbackVerified"] = session, false
		out["handoff"], out["remoteOperationsCanceled"], out["successFactsCreated"] = handoff, false, false
	}
	return out, l.check(ctx)
}
