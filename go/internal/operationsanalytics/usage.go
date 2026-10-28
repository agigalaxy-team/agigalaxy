package operationsanalytics

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"regexp"
	"strings"
	"time"
)

var usageMetrics = []string{"sessions", "screenViews", "totalEvents", "conversionEvents", "uniqueDaysActive", "avgSessionDurationMin", "p90SessionDurationMin", "avgEventsPerSession", "avgTimeBetweenSessionsSec", "bounceRate"}
var usageCountMetrics = []string{"sessions", "screenViews", "totalEvents", "conversionEvents", "uniqueDaysActive"}
var usageEvents = []string{"screen_view", "content-view", "content-click", "search", "search-click", "content-bookmark", "content-participate"}

func nativeInvalid() error { return fail("discovery_engine_response_invalid", 503) }
func nativeTimezone(v any) Object {
	r := obj(v)
	source := str(r["source"])
	if !has([]string{"native-project-settings", "native-clickhouse-default"}, source) {
		return nil
	}
	var name any
	if s := str(r["name"]); s != "" && len(s) <= 80 && s != "Local" {
		if _, e := time.LoadLocation(s); e == nil {
			name = s
		}
	}
	return Object{"source": source, "name": name}
}
func usageLifetime(v any, id string) (Object, error) {
	data := obj(v)
	if data == nil || str(data["profileId"]) != "account:"+id {
		return nil, nativeInvalid()
	}
	out := Object{}
	for _, k := range usageMetrics {
		n, ok := num(data[k])
		if !ok || has(usageCountMetrics, k) && (n != float64(int64(n)) || n > 9007199254740991) || k == "bounceRate" && n > 100 {
			out[k] = nil
		} else {
			out[k] = n
		}
	}
	out["firstSeen"], out["lastSeen"] = iso(data["firstSeen"]), iso(data["lastSeen"])
	return out, nil
}
func usagePaths(v any) (Object, error) {
	data := obj(v)
	if data == nil {
		return nil, nativeInvalid()
	}
	nodes, nok := data["nodes"].([]any)
	links, lok := data["links"].([]any)
	if !nok || !lok || len(nodes) > 200 || len(links) > 1000 {
		return nil, nativeInvalid()
	}
	ids := map[string]Object{}
	nn, ll := []Object{}, []Object{}
	for _, raw := range nodes {
		r := obj(raw)
		id := str(r["id"])
		step, ok := integer(r["step"])
		if r == nil || id == "" || protocol.TextLength(id) > 4096 || ids[id] != nil || !has(usageEvents, str(r["label"])) || !ok || step < 1 || step > 10 {
			return nil, nativeInvalid()
		}
		local := fmt.Sprintf("n%d", len(nn))
		ids[id] = Object{"id": local, "step": step}
		var pct any
		if n, ok := num(r["percentage"]); ok && n <= 100 {
			pct = n
		}
		nn = append(nn, Object{"id": local, "label": r["label"], "step": step, "value": number(r["value"]), "percentage": pct})
	}
	for _, raw := range links {
		r := obj(raw)
		from, to := ids[str(r["source"])], ids[str(r["target"])]
		if from == nil || to == nil || count(to["step"]) <= count(from["step"]) {
			return nil, nativeInvalid()
		}
		ll = append(ll, Object{"source": from["id"], "target": to["id"], "value": number(r["value"])})
	}
	return Object{"nodes": nn, "links": ll}, nil
}
func usageBasis(source Object, kind, id string, days int) (Object, error) {
	v := obj(source["basis"])
	if v == nil || str(source["kind"]) != kind || source["source"] != "openpanel-native" || source["purpose"] != "site-usage-analytics" {
		return nil, nativeInvalid()
	}
	if kind == "account" {
		if v["window"] != "native-lifetime" || v["accountId"] != id {
			return nil, nativeInvalid()
		}
		return Object{"window": "native-lifetime", "accountId": id}, nil
	}
	if v["identityScope"] != "accounts" || v["population"] != "single-account-profile" || v["accountOnly"] != true || v["accountId"] != id {
		return nil, nativeInvalid()
	}
	out := Object{"identityScope": "accounts", "population": "single-account-profile", "accountOnly": true, "accountId": id, "timezone": nativeTimezone(v["timezone"])}
	if kind == "retention" {
		if v["window"] != "native-last-12-weeks" || v["interval"] != "week" || v["criteria"] != "on_or_after" || v["activity"] != "any-event" || v["cohortEntry"] != "first-qualified-activity-in-window" || v["accountPrefixFilterSupported"] != true {
			return nil, nativeInvalid()
		}
		for _, k := range []string{"window", "interval", "criteria", "activity", "cohortEntry", "accountPrefixFilterSupported"} {
			out[k] = v[k]
		}
		return out, nil
	}
	from, to := iso(v["from"]), iso(v["to"])
	if v["unit"] != "account-session-path-transitions" || v["scope"] != "native-top-paths" || from == nil || to == nil {
		return nil, nativeInvalid()
	}
	a, _ := time.Parse(time.RFC3339Nano, str(from))
	b, _ := time.Parse(time.RFC3339Nano, str(to))
	if b.Sub(a) != time.Duration(days)*24*time.Hour {
		return nil, nativeInvalid()
	}
	out["from"], out["to"], out["unit"], out["scope"], out["classification"] = from, to, v["unit"], v["scope"], "event-family"
	return out, nil
}
func (s *Service) usagePart(ctx context.Context, a Actor, kind, id string, days int) (Object, error) {
	empty := func(state, code string) Object {
		return Object{"availability": Object{"state": state, "code": code}, "checkedAt": s.now(), "readExpiresAt": s.now() + 30, "basis": nil, "data": nil}
	}
	if s.Runtime == nil {
		return empty("not-connected", "discovery_analysis_not_connected"), nil
	}
	q := Object{"kind": kind, "accountId": id}
	if kind != "account" {
		q["scope"] = "accounts"
	}
	if kind == "paths" {
		q["days"] = days
	}
	source, e := s.Runtime.Analytics(ctx, a, q)
	if e == nil {
		basis, err := usageBasis(source, kind, id, days)
		if err != nil {
			e = err
		} else {
			at, ok := integer(source["checkedAt"])
			if !ok || at > s.now() {
				e = nativeInvalid()
			} else {
				var data any
				switch kind {
				case "account":
					data, e = usageLifetime(source["data"], id)
				case "paths":
					data, e = usagePaths(source["data"])
				default:
					data = NormalizeRetention(source["data"], at, str(obj(basis["timezone"])["name"]))
					if data == nil {
						e = nativeInvalid()
					}
				}
				if e == nil {
					return Object{"availability": Object{"state": "available", "code": nil}, "checkedAt": at, "readExpiresAt": at + 30, "basis": basis, "data": data}, nil
				}
			}
		}
	}
	code := fault.Code(e)
	if code == "discovery_analysis_not_connected" {
		return empty("not-connected", code), nil
	}
	if fault.Status(e) == 503 && has([]string{"discovery_engine_unavailable", "discovery_engine_failed", "discovery_engine_authorization_failed", "discovery_engine_response_invalid", "discovery_analysis_scope_unavailable"}, code) {
		return empty("unavailable", code), nil
	}
	return nil, e
}
func (s *Service) Usage(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	days, e := parseDays(input)
	if e != nil || !validID(id) {
		return nil, fail("invalid_business_admin_request", 400)
	}
	id = strings.ToLower(id)
	actor, e := s.current(ctx, a, id)
	if e != nil {
		return nil, e
	}
	life, e := s.usagePart(ctx, actor, "account", id, days)
	if e != nil {
		return nil, e
	}
	flow, e := s.usagePart(ctx, actor, "paths", id, days)
	if e != nil {
		return nil, e
	}
	retention, e := s.usagePart(ctx, actor, "retention", id, days)
	if e != nil {
		return nil, e
	}
	if _, e = s.current(ctx, actor, id); e != nil {
		return nil, e
	}
	at := s.now()
	expires := at + 30
	for _, part := range []Object{life, flow, retention} {
		if count(part["readExpiresAt"]) <= at {
			part["availability"], part["data"], part["basis"], part["readExpiresAt"] = Object{"state": "unavailable", "code": "operations_account_usage_expired"}, nil, nil, at+30
		}
		if n := count(part["readExpiresAt"]); n < expires {
			expires = n
		}
	}
	return Object{"accountId": id, "source": "openpanel-native", "purpose": "site-usage-analytics", "coverage": []string{"home", "community", "find", "account", "help", "download"}, "historicalBackfill": false, "metadataOnly": true, "checkedAt": at, "readExpiresAt": expires, "lifetime": life, "paths": flow, "retention": retention}, nil
}

var cohortPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(?:$|[ T])`)
