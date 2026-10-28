package native

import "context"

func (h *NativeWatch) RecordHostExecution(ctx context.Context, l *nativeIdentityLease, id, workID string, execution map[string]any) error {
	if !isOne(text(execution["state"]), "dispatching", "completed", "failed", "interrupted", "unknown") {
		return watchFailure("watch_host_result_invalid")
	}
	_, _, e := h.state(ctx, l, func(state map[string]any) error {
		w := uploadObject(uploadObject(state["watches"])[id])
		pending := uploadObject(w["pending"])
		if w == nil || w["state"] != "active" || integer(w["expiresAt"]) <= h.now() || pending["workId"] != workID {
			return watchFailure("watch_work_changed")
		}
		prior := uploadObject(pending["hostExecution"])
		if prior["state"] == "completed" && execution["state"] != "completed" {
			return watchFailure("watch_host_result_changed")
		}
		if grant := text(execution["agentGrantId"]); grant != "" && grant != text(w["agentGrantId"]) {
			return watchFailure("watch_host_scope_changed")
		}
		saved := map[string]any{"state": execution["state"], "agentGrantId": w["agentGrantId"], "recordedAt": h.now()}
		for _, key := range []string{"model", "threadId", "turnId", "lease", "scopeKey"} {
			if v, ok := execution[key]; ok {
				saved[key] = v
			}
		}
		if reason := text(execution["reason"]); isOne(reason, "host_reader_configuration_unconfirmed", "selected-model-unavailable", "host-operation-unconfirmed", "host-disconnected", "completion-timeout", "scope-inactive") {
			saved["reason"] = reason
		}
		pending["hostExecution"] = saved
		return nil
	})
	return e
}
func (h *NativeWatch) RecordHostCancellation(ctx context.Context, l *nativeIdentityLease, id string, reference, result map[string]any) error {
	if text(reference["workId"]) == "" || text(reference["agentGrantId"]) == "" || text(reference["scopeKey"]) == "" {
		return nil
	}
	known := isOne(text(result["state"]), "completed", "interrupted", "failed")
	state := "unknown"
	if known {
		state = text(result["state"])
	}
	cancellation := map[string]any{"state": state, "cancellationConfirmed": result["state"] == "interrupted" && result["cancellationConfirmed"] == true, "executionEnded": known && result["executionEnded"] == true, "recordedAt": h.now()}
	_, _, e := h.state(ctx, l, func(state map[string]any) error {
		w := uploadObject(uploadObject(state["watches"])[id])
		old := uploadObject(uploadObject(w["hostStopReceipts"])[text(reference["workId"])])
		if old == nil || old["agentGrantId"] != reference["agentGrantId"] || old["scopeKey"] != reference["scopeKey"] {
			return nil
		}
		if text(old["threadId"]) != "" && reference["threadId"] != old["threadId"] || text(old["turnId"]) != "" && reference["turnId"] != old["turnId"] {
			return nil
		}
		if uploadObject(old["cancellation"])["executionEnded"] == true && cancellation["executionEnded"] != true {
			return nil
		}
		old["cancellation"] = cancellation
		last := uploadObject(w["lastHostExecution"])
		if last["workId"] == reference["workId"] && last["scopeKey"] == reference["scopeKey"] {
			last["cancellation"] = cancellation
		}
		return nil
	})
	return e
}
