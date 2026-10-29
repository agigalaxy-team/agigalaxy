package operationsautonomy

import (
	"time"
)

var inspectionSections = map[string]string{"workbench": "permitted-workbench", "maintenance": "adopted-river-and-components", "search": "search-overview", "recommendations": "recommendations-overview", "analytics": "analytics-overview", "messaging": "current-message-plans", "autonomy": "qualified-nonterminal-tasks", "delegation": "delegated-targets"}
var inspectionFactShape = map[string]map[string][]string{
	"workbench":       {"counts": {"communityReports", "chatReports", "sections", "resources", "files", "jobs", "feedback", "search"}},
	"maintenance":     {"processByState": {"running", "stopped", "failed", "not-applicable", "unknown"}, "queueCounts": {"created", "retry", "active", "completed", "cancelled", "failed"}, "healthByBasis": {"container-healthcheck", "native-health-endpoint", "prometheus-target", "prometheus-probe", "not-connected", "other-or-unavailable"}},
	"search":          {"metrics": {"searches", "measuredSearches", "resultKnownSearches", "noResults", "clickedSearches"}},
	"recommendations": {"metrics": {"exposures", "clicks", "bookmarks", "notInterested"}},
	"analytics":       {"summary": {"unique_visitors", "total_screen_views", "total_sessions"}},
	"messaging":       {"plans": {"total", "draft", "active", "paused", "stopped"}, "runs": {"total", "running", "paused", "blocked", "completed", "cancelled", "expired"}, "inapp": {"total", "pending", "submitting", "submitted", "delivered", "skipped", "failed", "unknown", "blocked"}},
	"autonomy":        {"tasksByState": {"queued", "running", "unknown", "waiting-human", "paused"}},
}
var inspectionBlockKeys = map[string][]string{"communityReports": {"pending", "total"}, "chatReports": {"pending", "total"}, "sections": {"active", "archived"}, "resources": {"projects", "methods"}, "files": {"scanPending", "scanFailed", "cleanupPending", "cleanupFailed", "cleanupResultUnknown"}, "jobs": {"failed"}, "feedback": {"total", "pending", "processing", "unclassified"}, "search": {"failed"}}
var inspectionHealthKeys = []string{"total", "healthy", "unhealthy", "unknown", "available", "notConfigured", "unavailable"}

func inspectionCount(v any) any {
	if integer(v, 0, 9007199254740991) {
		return v
	}
	return nil
}
func inspectionBool(v any) any {
	if b, ok := v.(bool); ok {
		return b
	}
	return nil
}
func inspectionDate(v any) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	if _, e := time.Parse(time.RFC3339Nano, s); e == nil {
		return s
	}
	if _, e := time.Parse("2006-01-02", s); e == nil {
		return s
	}
	return nil
}
func countMap(v any, keys []string) any {
	m := obj(v)
	if m == nil {
		return nil
	}
	out := Object{}
	for _, k := range keys {
		out[k] = inspectionCount(m[k])
	}
	return out
}

// inspectionReport projects only schema-owned aggregate facts. Unknown or
// absent fields remain null; no source body, free text or arbitrary key persists.
func inspectionReport(value any) Object {
	r := obj(value)
	if r == nil || !integer(r["schemaVersion"], 1, 1) || r["profile"] != "current-operations-v1" || !integer(r["checkedAt"], 1, 9007199254740991) {
		return nil
	}
	sections := obj(r["sections"])
	if sections == nil {
		return nil
	}
	out := Object{}
	for key, scope := range inspectionSections {
		s := obj(sections[key])
		if s == nil {
			return nil
		}
		availability := str(s["availability"])
		if !has([]string{"available", "partial", "unavailable", "not-authorized", "unknown"}, availability) {
			availability = "unknown"
		}
		window := obj(s["window"])
		coverage := obj(s["coverage"])
		days := inspectionCount(window["requestedDays"])
		if days != nil && !has([]string{"7", "30"}, str(days)) {
			if !integer(days, 7, 7) && !integer(days, 30, 30) {
				days = nil
			}
		}
		limit := inspectionCount(coverage["sampleLimit"])
		if limit != nil && !integer(limit, 12, 12) && !integer(limit, 20, 20) && !integer(limit, 100, 100) {
			limit = nil
		}
		facts := obj(s["facts"])
		projected := Object{}
		for group, keys := range inspectionFactShape[key] {
			if key == "workbench" && group == "counts" {
				src := obj(facts[group])
				if src == nil {
					projected[group] = nil
				} else {
					dst := Object{}
					for _, name := range keys {
						dst[name] = countMap(src[name], inspectionBlockKeys[name])
					}
					projected[group] = dst
				}
				continue
			}
			if key == "maintenance" && group == "healthByBasis" {
				src := obj(facts[group])
				if src == nil {
					projected[group] = nil
				} else {
					dst := Object{}
					for _, name := range keys {
						dst[name] = countMap(src[name], inspectionHealthKeys)
					}
					projected[group] = dst
				}
				continue
			}
			projected[group] = countMap(facts[group], keys)
		}
		switch key {
		case "maintenance":
			projected["componentTotal"] = inspectionCount(facts["componentTotal"])
		case "search":
			projected["activeVersion"], projected["draftVersion"] = inspectionCount(facts["activeVersion"]), inspectionCount(facts["draftVersion"])
			if has([]string{"available", "unavailable", "not-connected", "drifted"}, str(facts["nativeState"])) {
				projected["nativeState"] = facts["nativeState"]
			} else {
				projected["nativeState"] = nil
			}
		case "recommendations":
			projected["directionsComplete"] = inspectionBool(facts["directionsComplete"])
			if facts["supplyScope"] == "current-anonymous-public-community" {
				projected["supplyScope"] = facts["supplyScope"]
			} else {
				projected["supplyScope"] = nil
			}
		case "autonomy":
			projected["taskTotal"], projected["receiptCoverageComplete"] = inspectionCount(facts["taskTotal"]), inspectionBool(facts["receiptCoverageComplete"])
		case "delegation":
			projected["targetCount"], projected["promptsRead"] = inspectionCount(facts["targetCount"]), inspectionCount(facts["promptsRead"])
		}
		codes := []any{}
		for _, v := range list(s["findingCodes"]) {
			if has([]string{"maintenance-unhealthy", "process-failed", "queue-failed", "autonomy-unknown", "waiting-human", "source-incomplete", "not-authorized"}, str(v)) {
				codes = append(codes, v)
			}
		}
		if len(codes) > 8 {
			return nil
		}
		out[key] = Object{"availability": availability, "complete": inspectionBool(s["complete"]), "scope": scope, "window": Object{"requestedDays": days, "from": inspectionDate(window["from"]), "to": inspectionDate(window["to"])}, "coverage": Object{"sampleComplete": inspectionBool(coverage["sampleComplete"]), "sampleLimit": limit, "includesAllPlatformQueues": inspectionBool(coverage["includesAllPlatformQueues"]), "sourceWithheld": inspectionBool(coverage["sourceWithheld"])}, "facts": projected, "findingCodes": codes}
	}
	if _, ok := r["profileComplete"].(bool); !ok {
		return nil
	}
	return Object{"schemaVersion": 1, "profile": "current-operations-v1", "checkedAt": r["checkedAt"], "profileComplete": r["profileComplete"], "sections": out}
}
