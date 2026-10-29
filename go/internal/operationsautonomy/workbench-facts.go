package operationsautonomy

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
)

// WorkbenchRunFact and WorkbenchCardFact project observations from trusted
// Native/original-card ledgers. They accept no model-reported business effects.
func WorkbenchRunFact(run Object) Object {
	model, status := "unknown", "unknown"
	switch run["status"] {
	case "PENDING":
		model, status = "accepted", "running"
	case "RUNNING":
		model, status = "running", "running"
	case "COMPLETED":
		model, status = "completed", "completed"
	case "PAUSED":
		model, status = "running", "waiting-human"
	case "ERROR":
		model, status = "failed", "failed"
	case "CANCELLED":
		model, status = "cancelled", "stopped"
	}
	usage := obj(run["usage"])
	if run["usage"] == nil {
		usage = obj(run["metrics"])
	}
	out := Object{}
	for _, k := range usageKeys {
		out[k] = nil
		v, ok := usage[k].(float64)
		if i, yes := usage[k].(int); yes {
			v, ok = float64(i), true
		}
		if i, yes := usage[k].(int64); yes {
			v, ok = float64(i), true
		}
		if !ok || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			continue
		}
		if k != "durationMs" && (v != math.Trunc(v) || v > 9007199254740991) {
			continue
		}
		out[k] = v
	}
	return Object{"nativeRunId": run["runId"], "modelState": model, "status": status, "usage": out}
}

var targetTypes = map[string]string{"post": "content-post", "reply": "content-reply", "section": "content-section", "account": "account", "public-case": "community-report", "case": "community-report", "community-report": "community-report", "chat-report": "chat-report", "feedback": "feedback", "project": "project", "projects": "project", "method": "method", "methods": "method", "chat-file": "file-chat", "forum-file": "file-forum", "file-cleanup-plan": "file-cleanup-plan", "message-plan": "messaging-plan", "notice": "notice", "content-tag": "content-tag", "messaging-plan": "messaging-plan", "recommendation-theme": "recommendation-policy", "recommendation-policy": "recommendation-policy", "search-configuration": "search-quality", "search-quality": "search-quality", "rule": "rule-key", "rule-key": "rule-key", "queue-job": "queue-job", "search-job": "search-job", "strategy": "strategy", "strategy-configuration": "strategy-configuration", "strategy-run": "strategy-run", "ai-work-account": "ai-work-account", "ai-work-prompt": "ai-work-account", "ai-role": "ai-role", "ai-role-assignment": "ai-role-assignment"}

func OriginalOperationTarget(target, request Object) Object {
	kind := targetTypes[str(target["kind"])]
	if target["kind"] == "file" {
		kind = map[string]string{"chat": "file-chat", "forum": "file-forum"}[str(request["targetKind"])]
	}
	id, ok := target["id"].(string)
	if kind != "" && ok && id != "" && protocol.TextLength(id) <= 160 {
		return Object{"targetType": kind, "targetId": id}
	}
	return Object{"targetType": nil, "targetId": nil}
}
func OriginalBatchReceiptDetails(receipt Object) Object {
	rows, ok := receipt["items"].([]any)
	if !ok || len(rows) < 1 || len(rows) > 25 {
		return nil
	}
	items := []any{}
	for _, v := range rows {
		r := obj(v)
		item := Object{}
		for _, k := range []string{"kind", "id", "status", "code", "revision"} {
			if value, ok := r[k]; ok {
				item[k] = value
			}
		}
		items = append(items, item)
	}
	value := Object{"counts": receipt["counts"], "items": items}
	if !validDetails(value) {
		return nil
	}
	counts := obj(value["counts"])
	if num(counts["applied"]) > 25 || num(counts["rejected"]) > 25 {
		return nil
	}
	applied, rejected := int64(0), int64(0)
	seen := map[string]bool{}
	for _, v := range items {
		r := obj(v)
		key := str(r["kind"]) + ":" + str(r["id"])
		if seen[key] {
			return nil
		}
		seen[key] = true
		if r["status"] == "applied" {
			applied++
		} else {
			rejected++
		}
	}
	if num(counts["applied"]) != applied || num(counts["rejected"]) != rejected {
		return nil
	}
	return obj(clone(value))
}
func WorkbenchCardFact(card Object) Object {
	operationID := card["operation_id"]
	if operationID == nil {
		operationID = card["operationId"]
	}
	proposal := obj(card["proposal"])
	if card["proposal"] == nil {
		proposal = card
	}
	result := obj(card["result"])
	switch card["state"] {
	case "prepared":
		return Object{"status": "waiting-human"}
	case "processing":
		return Object{"status": "running"}
	case "not-available":
		if result["state"] == "cancelled" {
			return Object{"status": "stopped"}
		}
		return Object{"status": "waiting-human"}
	}
	if str(operationID) == "" || result["operationId"] != operationID {
		return nil
	}
	state := ""
	receiptObject := false
	switch result["receipt"].(type) {
	case map[string]any, []any:
		receiptObject = result["receipt"] != nil
	}
	if card["state"] == "completed" && result["state"] == "completed" && receiptObject {
		state = "completed"
	} else if card["state"] == "unknown" {
		state = "unknown"
	}
	if state == "" {
		return nil
	}
	kind := str(proposal["kind"])
	var details Object
	target := Object{"targetType": nil, "targetId": nil}
	if kind == "public-content-batch" {
		details = OriginalBatchReceiptDetails(obj(result["receipt"]))
		if details == nil {
			return nil
		}
	} else {
		target = OriginalOperationTarget(obj(proposal["target"]), obj(proposal["request"]))
		if has([]string{"file-cleanup-plan-create", "file-cleanup-plan-cancel"}, kind) {
			proposalTarget := obj(proposal["target"])
			if kind == "file-cleanup-plan-create" {
				if proposalTarget["kind"] != "file-cleanup-creation" || proposalTarget["id"] != nil {
					return nil
				}
				target = Object{"targetType": nil, "targetId": nil}
			} else if target["targetType"] != "file-cleanup-plan" || !schemaUUID.MatchString(str(target["targetId"])) {
				return nil
			}
			if state == "completed" {
				id := str(obj(result["receipt"])["planId"])
				if !schemaUUID.MatchString(id) || kind == "file-cleanup-plan-cancel" && id != str(target["targetId"]) {
					return nil
				}
				target = Object{"targetType": "file-cleanup-plan", "targetId": id}
			}
		}
		if has([]string{"content-tag-create", "content-tag-update"}, kind) {
			proposalTarget := obj(proposal["target"])
			if kind == "content-tag-create" {
				if proposalTarget["kind"] != "tag-creation" || proposalTarget["id"] != nil {
					return nil
				}
				target = Object{"targetType": nil, "targetId": nil}
			} else if target["targetType"] != "content-tag" || !schemaUUID.MatchString(str(target["targetId"])) {
				return nil
			}
			if state == "completed" {
				id := str(obj(result["receipt"])["tagId"])
				if !schemaUUID.MatchString(id) || kind == "content-tag-update" && id != str(target["targetId"]) {
					return nil
				}
				target = Object{"targetType": "content-tag", "targetId": id}
			}
		}
		if has([]string{"notice-draft-create", "notice-draft-save", "notice-state"}, kind) {
			// Notice effects are projected from the validated original receipt, never
			// from model text or a messaging-plan identifier. Keep the original
			// proposed ID for an unknown operation so later recovery retains its binding.
			proposedID := str(target["targetId"])
			if target["targetType"] != "notice" || !schemaUUID.MatchString(proposedID) || kind == "notice-draft-create" && proposedID != str(operationID) {
				return nil
			}
			if state == "completed" {
				noticeID := str(obj(result["receipt"])["noticeId"])
				if !schemaUUID.MatchString(noticeID) || noticeID != proposedID {
					return nil
				}
				target = Object{"targetType": "notice", "targetId": noticeID}
			}
		}
	}
	receipt := Object{"operationId": operationID, "action": proposal["kind"], "targetType": target["targetType"], "targetId": target["targetId"], "state": state, "basis": "workbench-original-domain-receipt"}
	if details != nil {
		receipt["details"] = details
	}
	return Object{"status": state, "businessReceipt": receipt}
}
