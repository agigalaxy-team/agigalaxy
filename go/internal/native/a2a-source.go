package native

import "context"

func a2aSameWorkSource(a, b map[string]any) bool {
	if a == nil || b == nil || a["kind"] != b["kind"] {
		return false
	}
	if a["kind"] == "local-work" {
		return a["workId"] == b["workId"] && a["host"] == b["host"] && a["sessionId"] == b["sessionId"]
	}
	return a["kind"] == "task" && a["taskId"] == b["taskId"]
}

// Source is the existing work selected for this exchange. It is separate from
// protocol taskId/contextId, and never invents a formal Case or Attempt.
func (h *NativeA2a) sourceAccess(ctx context.Context, l *nativeIdentityLease, selected, frozen map[string]any) (map[string]any, map[string]any, error) {
	source := selected
	if frozen != nil {
		source = frozen
	}
	switch text(source["kind"]) {
	case "local-work":
		value, e := h.runtime.store.WorkGet(ctx, WorkQuery{GalaxyID: l.scope.Owner, WorkID: text(source["workId"])})
		if e != nil {
			return nil, nil, e
		}
		work := uploadObject(uploadObject(value)["work"])
		if work == nil || work["galaxyId"] != l.scope.Owner || work["workId"] != source["workId"] {
			return nil, nil, a2aError("selected local work unavailable")
		}
		actual := map[string]any{"kind": "local-work", "workId": work["workId"], "host": work["host"], "sessionId": work["sessionId"], "throughSequence": work["lastSequence"]}
		if frozen != nil {
			if work["host"] != frozen["host"] || work["sessionId"] != frozen["sessionId"] || a2aInteger(work["lastSequence"]) < a2aInteger(frozen["throughSequence"]) {
				return nil, nil, a2aError("original local source changed")
			}
			actual = a2aClone(frozen)
		}
		return work, actual, l.check(ctx)
	case "task":
		task, e := l.call(ctx, "/v2/tasks/"+text(source["taskId"]), nil, false)
		if e != nil {
			return nil, nil, e
		}
		if task["taskId"] != source["taskId"] || a2aInteger(task["schemaVersion"]) != 2 || a2aInteger(task["version"]) < 1 {
			return nil, nil, a2aError("selected request unavailable")
		}
		actual := map[string]any{"kind": "task", "taskId": task["taskId"], "version": task["version"]}
		if frozen != nil {
			if a2aInteger(task["version"]) < a2aInteger(frozen["version"]) {
				return nil, nil, a2aError("original request source unavailable")
			}
			// A newer request projection does not change the recorded version
			// originally selected, or attach its new text to this exchange.
			actual = a2aClone(frozen)
		}
		return task, actual, l.check(ctx)
	}
	return nil, nil, a2aError("select real local work or a readable request")
}

func a2aSourceTitle(current map[string]any) string {
	if title := text(current["title"]); title != "" {
		return title
	}
	if title := text(uploadObject(current["request"])["title"]); title != "" {
		return title
	}
	for _, v := range uploadRows(current["events"]) {
		event := uploadObject(v)
		if event["kind"] == "case-created" {
			return text(event["title"])
		}
	}
	return "当前工作"
}
