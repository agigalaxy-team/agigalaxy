package operationsqueries

import (
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
)

var summaryBlocks = map[string][]string{"overview": {"communityReports", "chatReports", "sections", "resources", "files", "jobs", "feedback", "search"}, "governance": {"communityReports", "chatReports", "sections", "resources", "files", "feedback"}, "messaging": {"jobs"}, "discovery": {"sections", "search"}, "maintenance": {"files", "jobs", "search"}}
var countFields = map[string][]string{"communityReports": {"pending", "total"}, "chatReports": {"pending", "total"}, "sections": {"active", "archived"}, "resources": {"projects", "methods"}, "files": {"scanPending", "scanFailed", "cleanupPending", "cleanupFailed", "cleanupResultUnknown"}, "jobs": {"failed"}, "feedback": {"total", "pending", "processing", "unclassified"}, "search": {"failed"}}

func safeInteger(v any) any {
	n, ok := number(v)
	if !ok || n < 0 || n > 9007199254740991 || math.Trunc(n) != n {
		return nil
	}
	return n
}
func isoValue(v any) any {
	value, ok := v.(string)
	if !ok {
		return nil
	}
	if _, e := time.Parse(time.RFC3339Nano, value); e != nil {
		return nil
	}
	return value
}
func counts(source Object, keys []string) Object {
	result := Object{}
	for _, key := range keys {
		result[key] = safeInteger(source[key])
	}
	return result
}
func knownDomain(v any) bool { _, known := summaryBlocks[str(v)]; return known }
func summaryTasks(source any) []any {
	result := []any{}
	all := anyArray(source)
	for _, value := range all[:min(20, len(all))] {
		row := object(value)
		if !validID(row["id"]) || !knownDomain(row["domain"]) || !slices.Contains([]string{"queued", "running", "waiting-human", "paused", "completed", "failed", "unknown", "stopped"}, str(row["state"])) || !slices.Contains([]string{"workbench", "routine", "event", "recovery"}, str(row["source"])) {
			continue
		}
		var model, business any
		if slices.Contains([]string{"not-started", "pending", "running", "completed", "paused", "failed", "unknown", "cancelled"}, str(row["modelState"])) {
			model = row["modelState"]
		}
		if slices.Contains([]string{"not-started", "completed", "no-action", "waiting-human", "failed", "unknown", "cancelled"}, str(row["businessState"])) {
			business = row["businessState"]
		}
		result = append(result, Object{"id": row["id"], "domain": row["domain"], "source": row["source"], "state": row["state"], "modelState": model, "businessState": business, "updatedAt": isoValue(row["updatedAt"]), "href": "/admin/operations/ai-runs?task=" + str(row["id"])})
	}
	return result
}

// ConversationSummary is the original closed domain projection. It cannot
// carry operators, private prose, grants, URLs or obsolete static AI status.
func ConversationSummary(value Object, domain string, permissions []string) Object {
	availability, totals := Object{}, Object{}
	result := Object{"domain": domain, "checkedAt": safeInteger(value["checkedAt"]), "readExpiresAt": safeInteger(value["readExpiresAt"]), "basis": Object{"counts": "current-permitted-workbench-snapshot", "availability": "summary-block-only-not-query-capability", "recentChanges": "domain-subset-of-latest-12-operations-not-full-day"}, "countScopes": Object{"search": "search-index-recovery-backlog-not-search-quality-analytics"}, "availability": availability, "counts": totals, "recentChanges": []any{}}
	for _, key := range summaryBlocks[domain] {
		state := object(value["availability"])[key]
		if state != "available" && state != "not-authorized" {
			state = "unknown"
		}
		availability[key] = state
		if state == "available" && value[key] != nil {
			totals[key] = counts(object(value[key]), countFields[key])
		} else {
			totals[key] = nil
		}
	}
	if slices.Contains([]string{"overview", "governance", "discovery"}, domain) {
		state := object(value["availability"])["recentOperations"]
		if state != "available" && state != "not-authorized" {
			state = "unknown"
		}
		availability["recentOperations"] = state
		if state == "available" {
			items := []any{}
			rows := anyArray(value["recentOperations"])
			for _, v := range rows[:min(12, len(rows))] {
				row := object(v)
				action := str(row["action"])
				allowed := domain == "overview" || domain == "governance" && (strings.HasPrefix(action, "community-") || strings.HasPrefix(action, "feedback-") || strings.HasPrefix(action, "chat-report") || strings.HasPrefix(action, "resources-") || strings.HasPrefix(action, "file-")) || domain == "discovery" && (strings.HasPrefix(action, "search-") || strings.HasPrefix(action, "recommendations."))
				if !allowed || !regexp.MustCompile(`^[a-z0-9.-]{1,100}$`).MatchString(action) || isoValue(row["createdAt"]) == nil {
					continue
				}
				items = append(items, Object{"action": action, "createdAt": row["createdAt"]})
			}
			result["recentChanges"] = items
		}
	}
	state := "unavailable"
	if !slices.Contains(permissions, "autonomy.read") {
		state = "not-authorized"
	} else if object(value["availability"])["ai"] == "available" && value["autonomy"] != nil {
		state = "available"
	}
	availability["autonomy"] = state
	if state == "available" {
		source := object(value["autonomy"])
		accounts := []any{}
		for _, v := range anyArray(source["accounts"]) {
			row := object(v)
			if !knownDomain(row["domain"]) {
				continue
			}
			health := str(row["health"])
			if !slices.Contains([]string{"pending", "healthy", "attention", "unavailable", "blocked", "unknown"}, health) {
				health = "unknown"
			}
			accounts = append(accounts, Object{"domain": row["domain"], "enabled": object(row["config"])["enabled"] == true, "health": health, "lastValidAt": isoValue(row["lastValidAt"]), "nextDueAt": isoValue(row["nextDueAt"])})
		}
		result["autonomy"] = Object{"basis": "current-permitted-autonomy-snapshot-recorded-tasks-only", "checkedAt": safeInteger(source["checkedAt"]), "readExpiresAt": safeInteger(source["readExpiresAt"]), "summary": counts(object(source["summary"]), strings.Fields("enabledAccounts healthyAccounts active queued waitingHuman failed unknown businessCompleted expected completed late backlog")), "accounts": accounts, "recentTasks": summaryTasks(source["recentTasks"]), "humanTasks": summaryTasks(source["humanTasks"]), "exceptions": summaryTasks(source["exceptions"])}
	}
	return result
}
