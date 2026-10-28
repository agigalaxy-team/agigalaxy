package discovery

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"time"
)

var businessEvents = map[string]string{"reads": "content-view", "searches": "search", "bookmarks": "content-bookmark", "participations": "content-participate"}
var recommendationEvents = map[string]string{"exposures": "content-exposure", "clicks": "content-click", "bookmarks": "content-bookmark", "notInterested": "not-interested"}
var pagePaths = map[string]string{"home": "/app/", "community": "/app/community", "find": "/app/find", "account": "/app/account", "help": "/help", "download": "/download"}

type OpenPanel struct {
	writer, reader nativeClient
	project        string
	Now            func() time.Time
}

func NewOpenPanel(config OpenPanelConfiguration, options ClientOptions) (*OpenPanel, error) {
	if !serviceSecret(config.ClientID) || !serviceSecret(config.ClientSecret) || !serviceSecret(config.ReadClientID) || !serviceSecret(config.ReadClientSecret) || !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(config.ProjectID) {
		return nil, fail("discovery_configuration_invalid")
	}
	writer, e := newNative(config.URL, http.Header{"Openpanel-Client-Id": []string{config.ClientID}, "Openpanel-Client-Secret": []string{config.ClientSecret}}, options)
	if e != nil {
		return nil, e
	}
	reader, e := newNative(config.URL, http.Header{"Openpanel-Client-Id": []string{config.ReadClientID}, "Openpanel-Client-Secret": []string{config.ReadClientSecret}}, options)
	if e != nil {
		return nil, e
	}
	return &OpenPanel{writer: writer, reader: reader, project: config.ProjectID}, nil
}
func (o *OpenPanel) Track(ctx context.Context, event Object) error {
	properties := Object{"galaxy_event_id": event["eventId"], "purpose": "site-usage-analytics", "page_key": event["pageKey"], "__path": pagePaths[str(event, "pageKey")], "__timestamp": event["occurredAt"], "__deviceId": event["visitorId"]}
	if event["itemKey"] != nil {
		properties["content_id"] = event["itemKey"]
		properties["content_version"] = event["sourceVersion"]
		properties["topic"] = event["topic"]
	}
	for a, b := range map[string]string{"query": "query", "exposureId": "exposure_id"} {
		if value, present := event[a]; present {
			properties[b] = value
		}
	}
	if recommendation := object(event["recommendation"]); recommendation != nil {
		version := recommendation["policyVersion"]
		if version == nil {
			version = "none"
		}
		properties["galaxy_recommendation_request"] = recommendation["requestId"]
		properties["galaxy_policy_version"] = version
		properties["galaxy_placement"] = recommendation["placement"]
		properties["galaxy_position"] = recommendation["position"]
		properties["galaxy_candidate_source"] = recommendation["candidateSource"]
		properties["galaxy_theme_keys"] = jsonString(recommendation["themeKeys"])
	}
	if search := object(event["search"]); search != nil {
		version := search["configurationVersion"]
		if version == nil {
			version = "none"
		}
		properties["galaxy_search_request"] = search["requestId"]
		properties["galaxy_search_measured"] = "true"
		properties["galaxy_search_result"] = search["resultState"]
		properties["galaxy_search_version"] = version
		properties["query"] = search["query"]
		if n, ok := integer(search["position"]); ok && n != 0 {
			properties["galaxy_search_position"] = search["position"]
		}
	}
	name := str(event, "name")
	if name == "pageview" {
		name = "screen_view"
	}
	agent := ""
	if transport := object(event["transport"]); str(transport, "kind") == "website-http" {
		agent = str(transport, "userAgent")
	}
	_, e := o.writer.callWith(ctx, "/track", http.MethodPost, Object{"type": "track", "payload": Object{"name": name, "profileId": event["profileId"], "properties": properties}}, callOptions{UserAgent: agent})
	return e
}
func (o *OpenPanel) Tool(ctx context.Context, name string, args Object) (any, error) {
	return o.tool(ctx, name, args, callOptions{})
}
func (o *OpenPanel) tool(ctx context.Context, name string, args Object, options callOptions) (any, error) {
	routes := map[string]string{"get_analytics_overview": "overview", "get_retention_cohort": "retention/cohort", "get_user_flow": "user_flow", "query_events": "events", "get_profile_metrics": "profiles/" + url.PathEscape(str(args, "profileId")) + "/metrics", "get_profile_sessions": "profiles/" + url.PathEscape(str(args, "profileId")) + "/sessions"}
	route, ok := routes[name]
	if !ok {
		return nil, qualityFailure("discovery_analysis_not_supported", 400)
	}
	query := url.Values{}
	for key, value := range args {
		if key == "profileId" && name != "query_events" {
			continue
		}
		switch v := value.(type) {
		case string:
			query.Set(key, v)
		case bool:
			query.Set(key, strconv.FormatBool(v))
		case nil:
			query.Set(key, "null")
		default:
			query.Set(key, jsonString(v))
		}
	}
	path := "/insights/" + o.project + "/" + route
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	return o.reader.callWith(ctx, path, http.MethodGet, nil, options)
}
func (o *OpenPanel) AccountAnalysis(ctx context.Context, name string, args Object) (Object, error) {
	if name != "get_retention_cohort" && name != "get_user_flow" {
		return nil, qualityFailure("discovery_analysis_not_supported", 400)
	}
	args = merge(merge(Object{}, args), Object{"scope": "accounts"})
	var timezone any
	value, e := o.tool(ctx, name, args, callOptions{Inspect: func(headers http.Header) error {
		if headers.Get("X-Galaxy-Analytics-Scope") != "accounts" {
			return fail("discovery_analysis_scope_unavailable")
		}
		expected := str(args, "accountId")
		actual, present := headers["X-Galaxy-Analytics-Account-Id"]
		if expected == "" && present || expected != "" && (!present || len(actual) != 1 || actual[0] != expected) {
			return fail("discovery_analysis_scope_unavailable")
		}
		if value, present := headers["X-Galaxy-Analytics-Timezone"]; present {
			if len(value) != 1 {
				return fail("discovery_engine_response_invalid")
			}
			if _, e := time.LoadLocation(value[0]); e != nil || value[0] == "Local" || value[0] == "" {
				return fail("discovery_engine_response_invalid")
			}
			timezone = value[0]
		}
		return nil
	}})
	if e != nil {
		return nil, e
	}
	if name == "get_retention_cohort" {
		if _, ok := value.([]any); !ok {
			return nil, fail("discovery_engine_response_invalid")
		}
	} else {
		object := object(value)
		if _, ok := object["nodes"].([]any); !ok {
			return nil, fail("discovery_engine_response_invalid")
		}
		if _, ok := object["links"].([]any); !ok {
			return nil, fail("discovery_engine_response_invalid")
		}
	}
	return Object{"data": value, "timezone": timezone}, nil
}
func (o *OpenPanel) EventObserved(ctx context.Context, event Object) (bool, error) {
	now := time.Now()
	if o.Now != nil {
		now = o.Now()
	}
	value, e := o.Tool(ctx, "query_events", Object{"properties": Object{"galaxy_event_id": event["eventId"]}, "limit": 1, "startDate": event["occurredAt"], "endDate": now.Add(time.Minute).UTC().Format("2006-01-02T15:04:05.000Z")})
	if e != nil {
		return false, e
	}
	var visit func(any, int) bool
	visit = func(value any, depth int) bool {
		if depth >= 8 {
			return false
		}
		switch v := value.(type) {
		case Object:
			if object(v["properties"])["galaxy_event_id"] == event["eventId"] {
				return true
			}
			for _, child := range v {
				if visit(child, depth+1) {
					return true
				}
			}
		case []any:
			for _, child := range v {
				if visit(child, depth+1) {
					return true
				}
			}
		}
		return false
	}
	return visit(value, 0), nil
}
func (o *OpenPanel) Health(ctx context.Context) (any, error) {
	return o.writer.call(ctx, "/healthcheck", http.MethodGet, nil, false)
}
func nativeCount(value any) any {
	n, ok := integer(value)
	if !ok || n < 0 || n > 9007199254740991 {
		return nil
	}
	return n
}
func (o *OpenPanel) charts(ctx context.Context, from, to, rangeName string, definitions []Object) ([]any, error) {
	query := url.Values{"projectId": []string{o.project}, "startDate": []string{from}, "endDate": []string{to}, "interval": []string{"day"}, "range": []string{rangeName}, "previous": []string{"false"}, "breakdowns": []string{"[]"}, "series": []string{jsonString(definitions)}}
	v, e := o.reader.call(ctx, "/export/charts?"+query.Encode(), http.MethodGet, nil, false)
	if e != nil {
		return nil, e
	}
	series, ok := object(v)["series"].([]any)
	if !ok {
		return nil, fail("discovery_engine_response_invalid")
	}
	return series, nil
}
func purposeFilter() Object {
	return Object{"id": "A", "name": "properties.purpose", "operator": "is", "value": []string{"site-usage-analytics"}}
}
func (o *OpenPanel) BusinessCounts(ctx context.Context, from, to string) (Object, error) {
	definitions := []Object{}
	for _, key := range []string{"reads", "searches", "bookmarks", "participations"} {
		definitions = append(definitions, Object{"name": businessEvents[key], "segment": "event", "filters": []Object{purposeFilter()}})
	}
	series, e := o.charts(ctx, from, to, "7d", definitions)
	if e != nil {
		return nil, e
	}
	counts := Object{}
	for key, name := range businessEvents {
		var found Object
		n := 0
		for _, row := range series {
			r := object(row)
			if str(object(r["event"]), "name") == name {
				found = r
				n++
			}
		}
		var count any
		if n == 1 {
			count = nativeCount(object(found["metrics"])["sum"])
		}
		counts[key] = count
	}
	return counts, nil
}

var chartDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(?:$|[ T])`)

func reportFromSeries(series []any, names map[string]string, identityField string) Object {
	metrics := Object{}
	dates := map[string]Object{}
	for key, id := range names {
		var row Object
		n := 0
		for _, value := range series {
			r := object(value)
			if str(object(r["event"]), identityField) == id {
				row = r
				n++
			}
		}
		if n != 1 {
			row = nil
		}
		metrics[key] = nativeCount(object(row["metrics"])["sum"])
		points, ok := row["data"].([]any)
		if !ok {
			continue
		}
		seen := map[string]bool{}
		for _, value := range points {
			point := object(value)
			raw := str(point, "date")
			matched := chartDate.FindString(raw)
			if matched == "" {
				continue
			}
			date := matched[:10]
			parsed, e := time.Parse("2006-01-02", date)
			count := nativeCount(point["count"])
			if e != nil || parsed.Format("2006-01-02") != date || count == nil || seen[date] {
				continue
			}
			seen[date] = true
			if dates[date] == nil {
				dates[date] = Object{"date": date}
				for name := range names {
					dates[date][name] = nil
				}
			}
			dates[date][key] = count
		}
	}
	keys := []string{}
	for date := range dates {
		keys = append(keys, date)
	}
	sort.Strings(keys)
	items := []Object{}
	for _, key := range keys {
		items = append(items, dates[key])
	}
	availability := "not-collected"
	if len(items) > 0 {
		availability = "available"
	}
	return Object{"metrics": metrics, "trend": Object{"items": items, "availability": availability}}
}
func (o *OpenPanel) RecommendationReport(ctx context.Context, from, to string) (Object, error) {
	definitions := []Object{}
	filters := []Object{purposeFilter(), {"id": "B", "name": "properties.galaxy_placement", "operator": "is", "value": []string{"home-public-recommendations"}}}
	for _, key := range []string{"exposures", "clicks", "bookmarks", "notInterested"} {
		definitions = append(definitions, Object{"name": recommendationEvents[key], "segment": "event", "filters": filters})
	}
	series, e := o.charts(ctx, from, to, "30d", definitions)
	if e != nil {
		return nil, e
	}
	return reportFromSeries(series, recommendationEvents, "name"), nil
}
func (o *OpenPanel) SearchQualityReport(ctx context.Context, from, to string) (Object, error) {
	purpose := purposeFilter()
	measured := Object{"id": "B", "name": "properties.galaxy_search_measured", "operator": "is", "value": []string{"true"}}
	definitions := []Object{{"id": "galaxy-searches", "name": "search", "segment": "event", "filters": []Object{purpose}}, {"id": "galaxy-no-results", "name": "search", "segment": "event", "filters": []Object{purpose, measured, {"id": "C", "name": "properties.galaxy_search_result", "operator": "is", "value": []string{"no-results"}}}}, {"id": "galaxy-clicks", "name": "search-click", "segment": "event", "filters": []Object{purpose, measured}}}
	series, e := o.charts(ctx, from, to, "7d", definitions)
	if e != nil {
		return nil, e
	}
	return reportFromSeries(series, map[string]string{"searches": "galaxy-searches", "noResults": "galaxy-no-results", "clicks": "galaxy-clicks"}, "id"), nil
}
