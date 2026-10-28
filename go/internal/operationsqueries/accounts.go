package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"regexp"
)

var profileTopicKey = regexp.MustCompile(`^(category:(technology|arts|learning|life|galaxy|unclassified)|(tag|theme):[a-f0-9-]{36})$`)
var profileSourceCodes = []string{"public-content-use", "public-authoring", "public-search", "gorse-returned-candidates", "recommendation-attribution"}
var profileSignalKeys = []string{"views", "clicks", "bookmarks", "participations", "publicPosts", "publicReplies", "searches", "notInterested"}
var profileRecommendationKeys = []string{"returnedCandidates", "exposures", "clicks", "bookmarks", "participations", "notInterested"}

func selectStrings(value any, allowed []string) []any {
	out := []any{}
	if rows, ok := value.([]any); ok {
		for _, v := range rows {
			if oneOf(v, allowed...) != nil {
				out = append(out, v)
			}
		}
	}
	return out
}
func profilePeriod(value any) Object {
	x := object(value)
	return Object{"from": extensionISO(x["from"]), "to": extensionISO(x["to"]), "timeZone": oneOf(x["timeZone"], "Asia/Shanghai")}
}
func profileRows(value any, recommendations bool) []any {
	out := []any{}
	items, ok := value.([]any)
	if !ok {
		return out
	}
	for _, v := range items {
		x := object(v)
		label, ok := x["label"].(string)
		if !profileTopicKey.MatchString(str(x["key"])) || !ok || protocol.TextLength(label) > 200 || oneOf(x["method"], "qualified-topic-observation-v1", "explicit-query-theme-map-v1", "issued-gorse-categories-v1") == nil {
			continue
		}
		summary, _ := utf16Preview(x["summary"], 500)
		values := x["counts"]
		if values == nil {
			values = x["signalCounts"]
		}
		countKeys, name := profileSignalKeys, "signalCounts"
		if recommendations {
			countKeys, name = profileRecommendationKeys, "counts"
		}
		out = append(out, Object{"key": x["key"], "label": label, "summary": summary, "method": x["method"], "sourceTypes": selectStrings(x["sourceTypes"], profileSourceCodes), name: counts(object(values), countKeys), "firstObservedAt": extensionISO(x["firstObservedAt"]), "lastObservedAt": extensionISO(x["lastObservedAt"])})
		if len(out) == 100 {
			break
		}
	}
	return out
}
func profileBasis(value any) Object {
	x := object(value)
	var self any
	if x["selfDeclared"] == false {
		self = false
	}
	return merge(Object{"source": oneOf(x["source"], "galaxy-normal-purpose-ledger", "issued-recommendations-and-attributed-events"), "population": oneOf(x["population"], "single-account"), "purpose": oneOf(x["purpose"], "normal-public-use-profile"), "qualification": oneOf(x["qualification"], "current-anonymous-public-reader-and-exact-version"), "aggregation": oneOf(x["aggregation"], "category-and-explicit-theme-map"), "unit": oneOf(x["unit"], "observations"), "complete": extensionBool(x["complete"]), "scope": oneOf(x["scope"], "recorded-returned-candidates"), "doesNotIssueRecommendations": x["doesNotIssueRecommendations"] == true, "reasonCodes": selectStrings(x["reasonCodes"], []string{"not-connected", "unavailable", "not-authorized", "partial", "event-window-too-large", "public-authoring-window-too-large", "source-window-too-large", "topic-window-too-large", "recommendation-window-too-large", "invalid-recommendation-record", "unqualified-event-records-excluded"}), "negativeFeedback": oneOf(x["negativeFeedback"], "current-item-exclusion"), "selfDeclared": self}, counts(x, []string{"excludedSources", "unmappedSearches"}))
}
func profileAnalysis(value Object) Object {
	p, r := object(value["profile"]), object(value["recommendations"])
	state := func(v any) any {
		if s := oneOf(v, "available", "empty", "partial", "unavailable", "not-connected", "not-authorized", "not-analyzed"); s != nil {
			return s
		}
		return "unavailable"
	}
	return Object{"profile": Object{"state": state(p["state"]), "interests": profileRows(p["interests"], false), "needs": profileRows(p["needs"], false), "sourceTypes": selectStrings(p["sourceTypes"], profileSourceCodes), "updatedAt": extensionISO(p["updatedAt"]), "validUntil": nil, "period": profilePeriod(p["period"]), "basis": profileBasis(p["basis"])}, "recommendations": Object{"state": state(r["state"]), "categories": profileRows(r["categories"], true), "updatedAt": extensionISO(r["updatedAt"]), "period": profilePeriod(r["period"]), "basis": profileBasis(r["basis"])}}
}
func usageSessions(value any) Object {
	out := object(project(value, merge(shape("sessions screenViews totalEvents conversionEvents uniqueDaysActive avgSessionDurationMin p90SessionDurationMin avgEventsPerSession avgTimeBetweenSessionsSec bounceRate", "n"), shape("firstSeen lastSeen", "s"))))
	if n, ok := number(out["sessions"]); ok && n == 0 {
		for _, key := range []string{"avgSessionDurationMin", "p90SessionDurationMin", "avgEventsPerSession", "avgTimeBetweenSessionsSec", "bounceRate"} {
			out[key] = nil
		}
	} else if ok && n == 1 {
		out["avgTimeBetweenSessionsSec"] = nil
	}
	return out
}

var usageNode = regexp.MustCompile(`^n(?:0|[1-9][0-9]{0,2})$`)
var usageCohort = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
var usageEventNames = []string{"screen_view", "content-view", "content-click", "search", "search-click", "content-bookmark", "content-participate"}

func usagePart(value any, kind string) any {
	x := object(value)
	if x == nil {
		return nil
	}
	state := oneOf(object(x["availability"])["state"], "available", "not-connected", "unavailable")
	if state == nil {
		return nil
	}
	out := object(project(x, shape("checkedAt readExpiresAt", "n")))
	out["availability"] = Object{"state": state, "code": safeCode(object(x["availability"])["code"])}
	var basis any = project(x["basis"], merge(shape("window accountId identityScope population from to unit scope classification interval criteria activity cohortEntry", "s"), shape("accountOnly accountPrefixFilterSupported", "b"), Object{"timezone": shape("source name", "s")}))
	if v, present := x["basis"]; present && v == nil {
		basis = nil
	}
	out["basis"] = basis
	if v, present := x["data"]; present && v == nil {
		out["data"] = nil
		return out
	}
	if kind == "lifetime" {
		out["data"] = usageSessions(x["data"])
		return out
	}
	data := object(x["data"])
	if kind == "paths" {
		nodes, nok := data["nodes"].([]any)
		links, lok := data["links"].([]any)
		valid := nok && lok && len(nodes) <= 100 && len(links) <= 100
		ids := map[string]bool{}
		for _, v := range nodes {
			n := object(v)
			id := str(n["id"])
			if !usageNode.MatchString(id) || ids[id] || oneOf(n["label"], usageEventNames...) == nil {
				valid = false
			}
			ids[id] = true
		}
		for _, v := range links {
			l := object(v)
			if !ids[str(l["source"])] || !ids[str(l["target"])] {
				valid = false
			}
		}
		if valid {
			out["data"] = project(data, Object{"nodes": []any{merge(shape("id label", "s"), shape("step value percentage", "n"))}, "links": []any{merge(shape("source target", "s"), Object{"value": "n"})}})
			return out
		}
	} else {
		rows, rok := data["rows"].([]any)
		weeks, wok := data["weeks"].([]any)
		valid := rok && wok && len(rows) <= 100 && len(weeks) <= 13
		for _, v := range weeks {
			n, ok := number(v)
			if !ok || safeInteger(v) == nil || n > 12 {
				valid = false
			}
		}
		for _, v := range rows {
			r := object(v)
			cohort := str(r["cohort"])
			cells, ok := r["cells"].([]any)
			if cohort != "Weighted Average" && !usageCohort.MatchString(cohort) || !ok || len(cells) > 13 {
				valid = false
			}
			for _, v := range cells {
				if oneOf(object(v)["state"], "recorded", "unknown", "not-reached") == nil {
					valid = false
				}
			}
		}
		if valid {
			out["data"] = Object{"weeks": weeks, "rows": project(rows, []any{Object{"cohort": "s", "average": "b", "size": "n", "cells": []any{merge(shape("week count ratio", "n"), Object{"state": "s"})}}})}
			return out
		}
	}
	out["availability"], out["data"] = Object{"state": "unavailable", "code": "operations_query_response_invalid"}, nil
	return out
}
func usageAnalysis(value any) any {
	x := object(value)
	if x == nil || x["source"] != "openpanel-native" || x["purpose"] != "site-usage-analytics" {
		return nil
	}
	return merge(object(project(x, merge(Object{"accountId": "s", "checkedAt": "n", "readExpiresAt": "n"}, shape("historicalBackfill metadataOnly", "b")))), Object{"source": "openpanel-native", "purpose": "site-usage-analytics", "coverage": selectStrings(x["coverage"], []string{"home", "community", "find", "account", "help", "download"}), "lifetime": usagePart(x["lifetime"], "lifetime"), "paths": usagePart(x["paths"], "paths"), "retention": usagePart(x["retention"], "retention")})
}
func accountSummary(value Object) Object {
	return merge(object(project(value, Object{"accountId": "s", "days": "n", "period": shape("from to timeZone", "s"), "usage": merge(shape("activeDays searches bookmarks participation publicContributions", "n"), shape("lastActivityAt basis publicActivityState publicActivityReason", "s"), Object{"dailyActivity": []any{Object{"date": "s", "count": "n"}}}), "predictions": Object{"participation": Object{"state": "s"}, "needs": Object{"state": "s"}}})), profileAnalysis(value), Object{"usageAnalysis": usageAnalysis(value["usageAnalysis"])})
}
func (s *Service) accounts(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Accounts == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	view := args.view
	if args.kind == "account" {
		view = "get"
	} else if args.kind == "account-summary" {
		view = "accountSummary"
	} else if args.view == "summary" {
		view = "directorySummary"
	}
	value, e := s.Accounts.QueryRead(ctx, a, s.reader(a), view, args.id, args.filters)
	if e != nil {
		return queryResult{}, e
	}
	value, e = queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	if args.kind != "" {
		row := value
		data := accountSummary(value)
		if args.kind == "account" {
			row = object(value["account"])
			if row == nil {
				return queryResult{}, fail("operations_query_response_invalid", 503)
			}
			data = object(project(row, accountShape))
		}
		return queryResult{source: value, data: data, refs: []reference{{kind: args.kind, id: args.id, row: row, filters: args.filters}}}, nil
	}
	if args.view == "summary" {
		return queryResult{source: value, data: object(project(value, Object{"coverage": "s", "days": "n", "period": shape("from to timeZone", "s"), "totals": shape("accounts person agent organization unknown restricted active", "n")}))}, nil
	}
	return typedList(args, value, func(row Object) Object { return object(project(row, accountShape)) }, fixedKind("account"))
}
