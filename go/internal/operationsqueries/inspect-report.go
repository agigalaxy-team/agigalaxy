package operationsqueries

import (
	"slices"
	"time"
)

var inspectionReportKeys = []string{"workbench", "maintenance", "search", "recommendations", "analytics", "messaging", "autonomy", "delegation"}

func reportCounts(source Object, keys ...string) Object {
	out := Object{}
	for _, key := range keys {
		out[key] = safeInteger(source[key])
	}
	return out
}

func reportBool(value any) any {
	if v, ok := value.(bool); ok {
		return v
	}
	return nil
}

func reportDate(value any) any {
	s, ok := value.(string)
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

func reportPositive(value any) bool {
	n, ok := number(value)
	return ok && n > 0 && safeInteger(value) != nil
}

// inspectionReport projects only fixed, bounded source facts. It never copies
// query terms, prompt text, audience, source identifiers, or model prose.
func inspectionReport(result Object) Object {
	segments := object(result["segments"])
	sections := Object{}
	for _, key := range inspectionReportKeys {
		s := object(segments[key])
		availability := str(s["availability"])
		if !slices.Contains([]string{"available", "partial", "unavailable", "not-authorized"}, availability) {
			availability = "unknown"
		}
		complete := s["collectionComplete"] == true
		if key == "recommendations" {
			complete = s["profileComplete"] == true
		}
		scopes := map[string]string{"workbench": "permitted-workbench", "maintenance": "adopted-river-and-components", "search": "search-overview", "recommendations": "recommendations-overview", "analytics": "analytics-overview", "messaging": "current-message-plans", "autonomy": "qualified-nonterminal-tasks", "delegation": "delegated-targets"}
		window := Object{"requestedDays": nil, "from": nil, "to": nil}
		coverage := Object{"sampleComplete": nil, "sampleLimit": nil, "includesAllPlatformQueues": nil, "sourceWithheld": nil}
		facts := Object{}
		findings := []any{}
		data := object(s["data"])
		switch key {
		case "workbench":
			blocks := Object{}
			for _, block := range []string{"communityReports", "chatReports", "sections", "resources", "files", "jobs", "feedback", "search"} {
				blocks[block] = reportCounts(object(object(data["counts"])[block]), countFields[block]...)
			}
			facts["counts"] = blocks
			coverage["sampleLimit"] = 12
		case "maintenance":
			components := object(data["componentSummary"])
			facts["componentTotal"] = safeInteger(components["total"])
			process := reportCounts(object(components["processByState"]), "running", "stopped", "failed", "not-applicable", "unknown")
			facts["processByState"] = process
			groups := Object{}
			for _, basis := range []string{"container-healthcheck", "native-health-endpoint", "prometheus-target", "prometheus-probe", "not-connected", "other-or-unavailable"} {
				groups[basis] = nil
			}
			for _, item := range anyArray(components["healthByBasis"]) {
				v := object(item)
				basis := str(v["basis"])
				if _, ok := groups[basis]; ok {
					groups[basis] = reportCounts(v, "total", "healthy", "unhealthy", "unknown", "available", "notConfigured", "unavailable")
				}
				if reportPositive(v["unhealthy"]) && !slices.Contains(findings, any("maintenance-unhealthy")) {
					findings = append(findings, "maintenance-unhealthy")
				}
			}
			facts["healthByBasis"] = groups
			if reportPositive(process["failed"]) {
				findings = append(findings, "process-failed")
			}
			queue := object(data["queues"])
			coverage["includesAllPlatformQueues"] = reportBool(queue["includesAllPlatformQueues"])
			totals := Object{}
			for _, state := range []string{"created", "retry", "active", "completed", "cancelled", "failed"} {
				var sum any
				if items, ok := queue["items"].([]any); ok && object(queue["availability"])["state"] == "available" {
					total := float64(0)
					valid := true
					for _, item := range items {
						n, ok := number(object(object(item)["counts"])[state])
						if !ok || safeInteger(n) == nil {
							valid = false
							break
						}
						total += n
					}
					if valid {
						sum = safeInteger(total)
					}
				}
				totals[state] = sum
			}
			facts["queueCounts"] = totals
			if reportPositive(totals["failed"]) {
				findings = append(findings, "queue-failed")
			}
		case "search", "recommendations":
			days := 7
			if key == "recommendations" {
				days = 30
			}
			window["requestedDays"] = days
			period := object(data["period"])
			window["from"], window["to"] = reportDate(period["from"]), reportDate(period["to"])
			metrics := object(data["metrics"])
			if key == "search" {
				facts["metrics"] = reportCounts(metrics, "searches", "measuredSearches", "resultKnownSearches", "noResults", "clickedSearches")
				configuration := object(data["configuration"])
				native := str(object(configuration["native"])["state"])
				facts["nativeState"] = oneOf(native, "available", "unavailable", "not-connected", "drifted")
				facts["activeVersion"] = safeInteger(object(configuration["active"])["version"])
				facts["draftVersion"] = safeInteger(object(configuration["draft"])["version"])
				sample := object(s["querySample"])
				coverage["sampleComplete"], coverage["sampleLimit"] = reportBool(sample["collectionComplete"]), safeInteger(sample["limit"])
			} else {
				facts["metrics"] = reportCounts(metrics, "exposures", "clicks", "bookmarks", "notInterested")
				facts["directionsComplete"] = reportBool(data["directionsComplete"])
				sample := object(s["supplySample"])
				coverage["sampleComplete"] = reportBool(sample["collectionComplete"])
				facts["supplyScope"] = oneOf(str(sample["scope"]), "current-anonymous-public-community")
			}
		case "analytics":
			window["requestedDays"] = 7
			basis := object(data["basis"])
			window["from"], window["to"] = reportDate(basis["from"]), reportDate(basis["to"])
			facts["summary"] = reportCounts(object(object(data["data"])["summary"]), "unique_visitors", "total_screen_views", "total_sessions")
		case "messaging":
			summary := object(data["summary"])
			facts["plans"] = reportCounts(object(summary["plans"]), "total", "draft", "active", "paused", "stopped")
			facts["runs"] = reportCounts(object(summary["runs"]), "total", "running", "paused", "blocked", "completed", "cancelled", "expired")
			facts["inapp"] = reportCounts(object(object(summary["delivery"])["inapp"]), "total", "pending", "submitting", "submitted", "delivered", "skipped", "failed", "unknown", "blocked")
			coverage["sampleComplete"], coverage["sampleLimit"] = reportBool(s["collectionComplete"]), 100
		case "autonomy":
			counts := object(s["taskCounts"])
			facts["taskTotal"] = safeInteger(counts["total"])
			facts["tasksByState"] = reportCounts(object(counts["byState"]), "queued", "running", "unknown", "waiting-human", "paused")
			facts["receiptCoverageComplete"] = reportBool(s["receiptCoverageComplete"])
			coverage["sourceWithheld"], coverage["sampleComplete"], coverage["sampleLimit"] = reportBool(s["sourceWithheld"]), reportBool(s["collectionComplete"]), safeInteger(s["sampleLimit"])
			if reportPositive(object(facts["tasksByState"])["unknown"]) {
				findings = append(findings, "autonomy-unknown")
			}
			if reportPositive(object(facts["tasksByState"])["waiting-human"]) {
				findings = append(findings, "waiting-human")
			}
		case "delegation":
			facts["targetCount"] = safeInteger(s["targetCount"])
			var read any
			if rows, ok := s["targets"].([]any); ok {
				count := 0
				for _, row := range rows {
					if object(row)["textComplete"] == true {
						count++
					}
				}
				read = count
			}
			facts["promptsRead"] = read
		}
		if availability == "not-authorized" {
			findings = append(findings, "not-authorized")
		} else if !complete {
			findings = append(findings, "source-incomplete")
		}
		sections[key] = Object{"availability": availability, "complete": complete && availability == "available", "scope": scopes[key], "window": window, "coverage": coverage, "facts": facts, "findingCodes": findings}
	}
	return Object{"schemaVersion": 1, "profile": "current-operations-v1", "checkedAt": safeInteger(result["checkedAt"]), "profileComplete": result["profileComplete"] == true, "sections": sections}
}
