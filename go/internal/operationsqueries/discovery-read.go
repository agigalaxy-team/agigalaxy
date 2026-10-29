package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsanalytics"
	"strings"
)

var queryMetrics = shape("exposures impressions clicks bookmarks notInterested engagement requests searches measuredSearches resultKnownSearches noResults noResultRate clickedSearches clickRate followUps scanLimited", "n")

func analyticsBasis(v any) any {
	return project(v, merge(shape("from to previousFrom previousTo window interval bounds precision aggregation unit scope population identityRule criteria activity identityScope accountId cohortEntry", "s"), Object{"windowSeconds": "n", "accountOnly": "b", "accountPrefixFilterSupported": "b", "timezone": shape("name source", "s")}))
}
func analyticsData(value any, kind string, at int64, basis Object) any {
	x := object(value)
	switch kind {
	case "overview":
		data := object(project(x, merge(Object{"summary": shape("unique_visitors total_screen_views total_sessions bounce_rate avg_session_duration views_per_session", "n"), "series": []any{merge(Object{"date": "s"}, shape("unique_visitors total_screen_views total_sessions", "n"))}}, shape("interval startDate endDate", "s"))))
		if n, ok := number(object(data["summary"])["total_sessions"]); ok && n == 0 {
			for _, k := range []string{"bounce_rate", "avg_session_duration", "views_per_session"} {
				object(data["summary"])[k] = nil
			}
		}
		return data
	case "business":
		return project(x, Object{"unit": "s", "current": shape("reads searches bookmarks participations", "n"), "previous": shape("reads searches bookmarks participations", "n")})
	case "retention":
		return operationsanalytics.NormalizeRetention(value, at, str(object(basis["timezone"])["name"]))
	case "paths":
		return project(x, Object{"nodes": []any{merge(shape("id label", "s"), shape("step value percentage", "n"))}, "links": []any{merge(shape("source target", "s"), Object{"value": "n"})}})
	}
	data := object(project(x, merge(shape("sessions screenViews totalEvents conversionEvents uniqueDaysActive avgSessionDurationMin p90SessionDurationMin avgEventsPerSession avgTimeBetweenSessionsSec bounceRate", "n"), shape("firstSeen lastSeen", "s"))))
	if n, ok := number(data["sessions"]); ok && n == 0 {
		for _, k := range []string{"avgSessionDurationMin", "p90SessionDurationMin", "avgEventsPerSession", "avgTimeBetweenSessionsSec", "bounceRate"} {
			data[k] = nil
		}
	} else if ok && n == 1 {
		data["avgTimeBetweenSessionsSec"] = nil
	}
	return data
}
func recommendationProjection(x Object) Object {
	data := object(project(x, Object{"period": merge(shape("from to", "s"), Object{"days": "n"}), "metrics": queryMetrics, "topics": Object{"items": []any{merge(shape("key label kind direction", "s"), shape("demand supply reads searches bookmarks participations exposures clicks notInterested", "n"), Object{"availability": shape("supply usage", "s")})}}, "catalog": Object{"items": []any{merge(shape("id key kind label", "s"), Object{"enabled": "b", "version": "n", "mapping": Object{"categories": []any{"s"}, "tagIds": []any{"s"}, "queryTerms": []any{"s"}}})}}, "policy": Object{"version": "n", "enabled": "b", "controls": shape("avoidRepetition avoidConcentration", "b")}, "basis": merge(shape("metricsSource topicSource recommendationAttribution demandUnit supplyScope", "s"), shape("historicalBackfill sourceScanComplete", "b"))}))
	var directions any
	complete := false
	if items, ok := object(x["policy"])["directions"].([]any); ok {
		rows := []any{}
		seen := map[string]bool{}
		complete = len(items) <= 100
		for _, v := range items {
			r := object(v)
			key, direction := strings.ToLower(str(r["key"])), str(r["direction"])
			if !discovery.QueryThemeKey(str(r["key"])) || oneOf(direction, "increase", "keep", "decrease") == nil || seen[key] {
				complete = false
				continue
			}
			seen[key] = true
			if len(rows) < 100 {
				rows = append(rows, Object{"themeKey": key, "direction": direction})
			}
		}
		directions = rows
	}
	data["directions"], data["directionsComplete"] = directions, complete
	return data
}
func searchProjection(x Object) Object {
	data := object(project(x, Object{"period": merge(shape("from to", "s"), Object{"days": "n"}), "metrics": queryMetrics, "trend": Object{"availability": "s", "items": []any{merge(Object{"date": "s"}, queryMetrics)}}, "queries": Object{"items": []any{merge(shape("key label", "s"), queryMetrics, Object{"issueCodes": []any{"s"}})}}, "configuration": Object{"revision": "n", "active": Object{"id": "s", "version": "n"}, "draft": Object{"id": "s", "version": "n"}, "pending": shape("operationId phase errorCode", "s"), "native": Object{"state": "s"}}, "basis": merge(shape("source metricsSource unit rates bounds qualityCollection noResult", "s"), Object{"historicalBackfill": "b"})}))
	var settings any
	if parsed, e := discovery.QuerySearchSettings(object(object(object(x["configuration"])["active"])["settings"])); e == nil {
		settings = parsed
	}
	data["activeSettings"] = settings
	var draftSettings any
	if draft := object(object(x["configuration"])["draft"]); draft != nil {
		if parsed, e := discovery.QuerySearchSettings(object(draft["settings"])); e == nil {
			draftSettings = parsed
		} else {
			data["draftSettingsUnavailable"] = true
		}
	}
	data["draftSettings"] = draftSettings
	return data
}
func (s *Service) discoveryRead(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	reader := s.Analytics
	if args.module == "recommendations" {
		reader = s.Recommendations
	} else if args.module == "search" {
		reader = s.Search
	}
	if reader == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	view := args.view
	if args.kind == "search-version" || args.kind == "recommendation-theme" {
		view = args.kind
	}
	value, e := reader.QueryRead(ctx, a, s.reader(a), view, args.id, args.filters)
	if e != nil {
		return queryResult{}, e
	}
	value, e = queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	if args.kind == "recommendation-theme" {
		theme := object(value["theme"])
		if theme == nil {
			return queryResult{}, fail("operations_query_response_invalid", 503)
		}
		return queryResult{source: value, data: Object{"theme": theme, "contentTrust": "configuration-data", "instructionAuthority": "none"}}, nil
	}
	if args.view == "policy" && args.module == "recommendations" {
		return queryResult{source: value, data: Object{"policy": value["policy"]}}, nil
	}
	if args.kind == "search-version" {
		version := object(value["version"])
		settings, e := discovery.QuerySearchSettings(object(version["settings"]))
		if e != nil {
			return queryResult{}, fail("operations_query_response_invalid", 503)
		}
		data := object(project(version, merge(shape("id kind createdAt restoredFrom", "s"), Object{"version": "n", "restorable": "b", "wasApplied": "b"})))
		data["settings"] = settings
		return queryResult{source: value, data: data}, nil
	}
	if args.module == "analytics" {
		at := s.now()
		if n, ok := number(value["checkedAt"]); ok {
			at = int64(n)
		}
		analytics := analyticsData(value["data"], args.view, at, object(value["basis"]))
		return queryResult{source: value, data: Object{"kind": value["kind"], "data": analytics, "basis": analyticsBasis(value["basis"]), "timeFacts": analyticsTimeFacts(object(value["basis"]), object(analytics)), "source": value["source"], "purpose": value["purpose"], "coverage": value["coverage"], "historicalBackfill": value["historicalBackfill"]}}, nil
	}
	if args.view == "history" {
		if args.module == "search" {
			return typedList(args, value, func(x Object) Object { return merge(historyItem(x), object(project(x, shape("versionId phase", "s")))) }, nil)
		}
		return typedList(args, value, historyItem, nil)
	}
	if args.module == "recommendations" {
		return queryResult{source: value, data: recommendationProjection(value)}, nil
	}
	var next any
	if cursor := object(value["queries"])["nextAfter"]; cursor != nil && cursor != "" {
		next = Object{"module": args.module, "view": args.view, "filters": merge(args.filters, Object{"after": cursor})}
	}
	return queryResult{source: value, data: searchProjection(value), pagination: Object{"next": next, "complete": next == nil}}, nil
}
