package operationsqueries

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"sort"
	"unicode/utf8"
)

func oneOf(value any, allowed ...string) any {
	for _, s := range allowed {
		if value == s {
			return value
		}
	}
	return nil
}
func fileItem(x Object) Object {
	out := object(project(x, merge(shape("id kind name state processingState scope version processingVersion createdAt uploadedAt expiresAt removedAt revokedAt", "s"), shape("size scanAttempts", "n"), shape("cleanupPending processingAvailable canRetryScan canRetryCleanup", "b"), Object{"access": merge(Object{"revision": "n", "until": "n", "restoreBlockedReason": "s"}, shape("stopped canStop canRestore", "b")), "scan": shape("state checkedAt", "s"), "cleanup": merge(Object{"state": "s"}, shape("objectRemoved executionObserved failureObserved", "b")), "accounting": shape("reservedBytes actualStoredBytes", "n")})))
	processing, truncated := utf16Preview(x["processingVersion"], 4096)
	if value, ok := processing.(string); !ok || value == "" || truncated {
		out["processingVersion"] = nil
		out["processingVersionUnavailable"] = true
		if original, ok := x["version"].(string); ok && original == str(x["processingVersion"]) {
			out["version"] = nil
		}
	} else {
		out["processingVersion"] = value
	}
	out["lastError"] = safeCode(x["lastError"])
	return out
}
func safeCode(value any) any {
	s, ok := value.(string)
	if !ok || len(s) < 1 || len(s) > 100 || s[0] < 'a' || s[0] > 'z' {
		return nil
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
			return nil
		}
	}
	return s
}
func cleanupCandidateItem(x Object) Object {
	out := object(project(x, merge(shape("id name expiresAt", "s"), shape("size referenceCount activeReferences", "n"), Object{"eligible": "b"})))
	out["kind"], out["reason"], out["blockedReason"] = oneOf(x["kind"], "chat", "forum"), oneOf(x["reason"], "expired", "unreferenced"), oneOf(x["blockedReason"], "processing-active", "reference-check-incomplete", "storage-unavailable")
	version, truncated := utf16Preview(x["expectedVersion"], 4096)
	if text, ok := version.(string); ok && text != "" && !truncated {
		out["expectedVersion"] = text
	} else {
		out["expectedVersion"] = nil
		out["expectedVersionUnavailable"] = true
	}
	return out
}
func cleanupPlanItem(x Object) Object {
	out := object(project(x, merge(shape("id createdAt approvedAt cancelledAt completedAt", "s"), shape("revision itemCount declaredBytes", "n"), Object{"counts": shape("pending removing removed skipped result-unknown", "n"), "createdBy": Object{"displayName": "s"}, "approvedBy": Object{"displayName": "s"}, "impact": merge(shape("serverCopyRemoval restorationAvailable", "b"), Object{"physicalBlocksReleased": "n"})})))
	out["state"] = oneOf(x["state"], "awaiting-approval", "queued", "running", "completed", "attention", "cancelled")
	if items, ok := x["items"].([]any); ok {
		rows := []any{}
		for _, v := range items[:min(50, len(items))] {
			r := object(v)
			o := object(project(r, merge(shape("id name expiresAt completedAt", "s"), shape("size referenceCount activeReferences attemptCount", "n"), Object{"objectRemoved": "b"})))
			o["kind"], o["reason"], o["state"] = oneOf(r["kind"], "chat", "forum"), oneOf(r["reason"], "expired", "unreferenced"), oneOf(r["state"], "pending", "removing", "removed", "skipped", "result-unknown")
			o["currentState"] = oneOf(r["currentState"], "prepared", "uploading", "scan-pending", "scanning", "available", "blocked", "erased", "revoked")
			o["resultCode"] = oneOf(r["resultCode"], "file-unavailable", "already-removed", "file-changed", "references-changed", "eligibility-changed", "plan-cancelled", "object-removed", "object-already-absent", "operations_permission_denied", "business_admin_denied", "operations_authorization_unavailable", "attachment_service_unavailable", "attachment_storage_unavailable", "attachment_storage_integrity_failed", "operations_file_cleanup_result_unknown", "operations_file_cleanup_unavailable")
			rows = append(rows, o)
		}
		out["items"] = rows
	}
	return out
}
func caseItem(x Object) Object {
	return object(project(x, merge(shape("id state createdAt closedAt restrictedUntil", "s"), Object{"version": "n", "target": merge(shape("kind postId versionId replyId", "s"), Object{"contentRevision": "n"}), "currentEffect": Object{"active": "b", "until": "s", "scope": "s"}})))
}
func pointText(value any, max int) (any, bool) {
	s, ok := value.(string)
	if !ok {
		return nil, false
	}
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]), true
	}
	return s, false
}
func caseDecision(x Object) any {
	if x == nil {
		return nil
	}
	return merge(object(project(x, merge(shape("id effectUntil createdAt", "s"), Object{"version": "n"}))), Object{"actorKind": oneOf(x["actorKind"], "identity", "business-operator"), "resolution": oneOf(x["resolution"], "dismissed", "accepted", "needs-review"), "restrictionAction": oneOf(x["restrictionAction"], "hide", "keep", "release")})
}
func caseDetail(x Object) (Object, error) {
	events, ok := x["events"].([]any)
	source := object(x["source"])
	available := source["availability"] == "available"
	if x["legacyPrivateNarrativeGranted"] != false || !ok || len(events) > 1000 || oneOf(source["availability"], "available", "unavailable") == nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	content := object(source["content"])
	if available {
		if _, ok := content["body"].(string); !ok {
			return nil, fail("operations_query_response_invalid", 503)
		}
	} else {
		content = nil
	}
	title, tt := pointText(content["title"], 160)
	body, bt := pointText(content["body"], 8000)
	links := []any{}
	lt := false
	if available {
		if values, ok := content["links"].([]any); ok {
			for _, v := range values {
				s, ok := v.(string)
				u, e := whatwg.Parse(s)
				valid := ok && e == nil && (u.Scheme() == "http" || u.Scheme() == "https") && u.Username() == "" && u.Password() == "" && utf8.RuneCountInString(s) <= 2048
				if valid && len(links) < 8 {
					links = append(links, s)
				} else {
					lt = true
				}
			}
		}
	}
	var public any
	if available {
		public = Object{"title": title, "body": body, "links": links}
	}
	coverage := Object{"sourceAvailable": available, "eventsAvailable": len(events), "eventsReturned": 0, "eventsComplete": false, "textComplete": !tt && !bt && !lt, "eventSelection": "all-current-authorized"}
	out := merge(caseItem(x), Object{"handling": project(x, shape("canModerate knownPartyConflict", "b")), "source": Object{"availability": oneOf(source["availability"], "available", "unavailable"), "locator": project(source["locator"], merge(shape("kind postId versionId replyId", "s"), Object{"contentRevision": "n"})), "publishedUntil": project(source["publishedUntil"], "n"), "content": public, "titleTruncated": tt, "bodyTruncated": bt, "linksTruncated": lt}, "events": []any{}, "initialDecision": caseDecision(object(x["initialDecision"])), "currentDecision": caseDecision(object(x["currentDecision"])), "material": Object{"purpose": "public-case-review", "trust": "untrusted-source-text", "instructionAuthority": "none", "scope": "current-service-authorized", "legacyPrivateNarrativeGranted": false, "coverage": coverage}})
	type chosen struct {
		index int
		value Object
	}
	selected := []chosen{}
	indices := []int{}
	if len(events) > 0 {
		indices = append(indices, 0)
		for i := len(events) - 1; i > 0; i-- {
			indices = append(indices, i)
		}
	}
	for _, i := range indices {
		event := object(events[i])
		summary, truncated := pointText(event["summary"], 1600)
		value := merge(object(project(event, merge(shape("id createdAt", "s"), Object{"version": "n"}))), Object{"kind": oneOf(event["kind"], "report", "supplement", "withdraw", "appeal", "resolve"), "actorKind": oneOf(event["actorKind"], "official-account", "business-operator"), "summary": summary, "summaryTruncated": truncated, "resolution": oneOf(event["resolution"], "dismissed", "accepted", "needs-review"), "restrictionAction": oneOf(event["restrictionAction"], "hide", "keep", "release"), "effectUntil": text(event["effectUntil"])})
		proposed := []any{}
		for _, c := range selected {
			proposed = append(proposed, c.value)
		}
		proposed = append(proposed, value)
		raw, e := protocol.EncodeJS(merge(out, Object{"events": proposed}))
		if e != nil {
			return nil, e
		}
		if len(raw) <= 120000 {
			selected = append(selected, chosen{i, value})
		}
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].index < selected[j].index })
	returned := []any{}
	for _, c := range selected {
		returned = append(returned, c.value)
		if c.value["summaryTruncated"] == true {
			coverage["textComplete"] = false
		}
	}
	out["events"] = returned
	coverage["eventsReturned"], coverage["eventsComplete"] = len(returned), len(returned) == len(events)
	if len(returned) != len(events) {
		coverage["eventSelection"] = "first-and-latest-within-output-budget"
	}
	return out, nil
}
