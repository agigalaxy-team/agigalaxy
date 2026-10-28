package discovery

import (
	"context"
	"strings"
	"sync"
	"time"
)

const accountAnalysisComponentSource = "https://agigalaxy.org/open-source/openpanel-public2-galaxy-path-memory-20261025-r1/source.tar.gz"

func accountAnalysisBasis(request, native Object, timezoneSource string) Object {
	population := "account-profiles"
	if request["accountId"] != nil {
		population = "single-account-profile"
	}
	basis := Object{"identityScope": "accounts", "population": population, "accountOnly": true, "timezone": Object{"source": timezoneSource, "name": native["timezone"]}, "componentSourceUrl": accountAnalysisComponentSource}
	if request["accountId"] != nil {
		basis["accountId"] = request["accountId"]
	}
	return basis
}
func overviewTimezone(value any) Object {
	if name := str(object(value), "timezone"); name != "" && len(name) <= 100 && name != "Local" {
		if _, e := time.LoadLocation(name); e == nil {
			return Object{"source": "native-project-settings", "name": name}
		}
	}
	return Object{"source": "not-reported", "name": nil}
}
func parseAnalytics(input Object) (Object, error) {
	if !onlyKeys(input, "kind", "days", "scope", "accountId") {
		return nil, invalid()
	}
	kind := str(input, "kind")
	if kind != "overview" && kind != "retention" && kind != "paths" && kind != "account" && kind != "business" {
		return nil, invalid()
	}
	days := int64(7)
	if value, present := input["days"]; present {
		n, ok := integer(value)
		if !ok || n < 1 || n > 90 {
			return nil, invalid()
		}
		days = n
	}
	out := Object{"kind": kind, "days": days}
	if value, present := input["scope"]; present {
		scope, ok := value.(string)
		if !ok || scope != "accounts" {
			return nil, invalid()
		}
		out["scope"] = scope
	}
	if value, present := input["accountId"]; present {
		id, ok := value.(string)
		if !ok || !validID(id) {
			return nil, invalid()
		}
		out["accountId"] = strings.ToLower(id)
	}
	scopeKind := kind == "retention" || kind == "paths"
	if out["scope"] != nil && !scopeKind || out["accountId"] != nil && kind != "account" && !(scopeKind && out["scope"] == "accounts") || kind == "account" && out["accountId"] == nil {
		return nil, invalid()
	}
	return out, nil
}
func (r *Runtime) Analytics(ctx context.Context, actor Actor, input Object) (Object, error) {
	business := &SearchQuality{Pool: r.Store.Pool, Endpoint: r.Store.Endpoint, Authority: r.Authority, Now: r.Now}
	if _, e := business.authorize(ctx, actor, "analytics.read"); e != nil {
		return nil, e
	}
	if r.OpenPanel == nil {
		return nil, fail("discovery_analysis_not_connected")
	}
	request, e := parseAnalytics(input)
	if e != nil {
		return nil, e
	}
	now := r.now()
	window := number(request, "days") * 86400
	from, to := iso(now-window), iso(now)
	var data any
	var basis Object
	switch str(request, "kind") {
	case "business":
		previousFrom, previousTo := iso(now-2*window), from
		var current, previous Object
		var currentError, previousError error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); current, currentError = r.OpenPanel.BusinessCounts(ctx, from, iso(now-1)) }()
		go func() {
			defer wg.Done()
			previous, previousError = r.OpenPanel.BusinessCounts(ctx, previousFrom, iso(now-window-1))
		}()
		wg.Wait()
		if currentError != nil {
			return nil, currentError
		}
		if previousError != nil {
			return nil, previousError
		}
		data = Object{"unit": "events", "current": current, "previous": previous}
		basis = Object{"from": from, "to": to, "previousFrom": previousFrom, "previousTo": previousTo, "windowSeconds": window, "bounds": "[from,to)", "precision": "second", "aggregation": "native-chart-metrics-sum", "eventNames": businessEvents}
	case "retention":
		if request["scope"] == "accounts" {
			args := Object{}
			if request["accountId"] != nil {
				args["accountId"] = request["accountId"]
			}
			native, e := r.OpenPanel.AccountAnalysis(ctx, "get_retention_cohort", args)
			if e != nil {
				return nil, e
			}
			data = native["data"]
			identityRule := "profile_id starts with account:"
			if request["accountId"] != nil {
				identityRule = "profile_id = account:<UUID>"
			}
			basis = merge(Object{"window": "native-last-12-weeks", "interval": "week", "criteria": "on_or_after", "activity": "any-event", "identityRule": identityRule, "accountPrefixFilterSupported": true, "cohortEntry": "first-qualified-activity-in-window"}, accountAnalysisBasis(request, native, "native-clickhouse-default"))
		} else {
			data, e = r.OpenPanel.Tool(ctx, "get_retention_cohort", Object{})
			if e != nil {
				return nil, e
			}
			basis = Object{"window": "native-last-12-weeks", "interval": "week", "criteria": "on_or_after", "activity": "any-event", "population": "mixed-account-and-visitor-profiles", "identityRule": "profile_id != device_id", "accountOnly": false, "accountPrefixFilterSupported": false}
		}
	case "paths":
		args := Object{"startDate": from, "endDate": to, "startEvent": "screen_view", "mode": "after", "steps": 5, "include": []string{"screen_view", "content-view", "content-click", "search", "search-click", "content-bookmark", "content-participate"}}
		if request["scope"] == "accounts" {
			if request["accountId"] != nil {
				args["accountId"] = request["accountId"]
			}
			native, e := r.OpenPanel.AccountAnalysis(ctx, "get_user_flow", args)
			if e != nil {
				return nil, e
			}
			data = native["data"]
			basis = merge(Object{"from": from, "to": to, "unit": "account-session-path-transitions", "scope": "native-top-paths"}, accountAnalysisBasis(request, native, "native-project-settings"))
		} else {
			data, e = r.OpenPanel.Tool(ctx, "get_user_flow", args)
			if e != nil {
				return nil, e
			}
			basis = Object{"from": from, "to": to, "unit": "session-path-transitions", "scope": "native-top-paths"}
		}
	case "account":
		data, e = r.OpenPanel.Tool(ctx, "get_profile_metrics", Object{"profileId": "account:" + str(request, "accountId")})
		if e != nil {
			return nil, e
		}
		basis = Object{"window": "native-lifetime", "accountId": request["accountId"]}
	default:
		data, e = r.OpenPanel.Tool(ctx, "get_analytics_overview", Object{"startDate": from, "endDate": to, "interval": "day"})
		if e != nil {
			return nil, e
		}
		basis = Object{"from": from, "to": to, "interval": "day", "timezone": overviewTimezone(data)}
	}
	if _, e = business.authorize(ctx, actor, "analytics.read"); e != nil {
		return nil, e
	}
	return Object{"kind": request["kind"], "data": data, "basis": basis, "source": "openpanel-native", "purpose": "site-usage-analytics", "coverage": []string{"home", "community", "find", "account", "help", "download"}, "checkedAt": r.now(), "historicalBackfill": false}, nil
}
