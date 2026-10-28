package operationsanalytics

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"regexp"
	"sort"
	"strings"
	"time"
)

var signalKeys = []string{"views", "clicks", "bookmarks", "participations", "publicPosts", "publicReplies", "searches", "notInterested"}
var recommendationKeys = []string{"returnedCandidates", "exposures", "clicks", "bookmarks", "participations", "notInterested"}
var profileThemeKey = regexp.MustCompile(`^(category:(technology|arts|learning|life|galaxy|unclassified)|(tag|theme):[a-f0-9-]{36})$`)
var sourceRevision = regexp.MustCompile(`^[1-9][0-9]{0,9}$`)

func stringsOf(v any) []string {
	if a, ok := v.([]string); ok {
		return a
	}
	out := []string{}
	for _, v := range list(v) {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
func appendUnique(a []string, values ...string) []string {
	for _, v := range values {
		if !has(a, v) {
			a = append(a, v)
		}
	}
	return a
}
func profileBasis(period Object, complete bool, reasons []string) Object {
	return Object{"source": "galaxy-normal-purpose-ledger", "population": "single-account", "purpose": "normal-public-use-profile", "qualification": "current-anonymous-public-reader-and-exact-version", "aggregation": "category-and-explicit-theme-map", "unit": "observations", "complete": complete, "period": period, "limits": Object{"events": 2000, "authored": 200, "requests": 200, "sourceRefs": 200, "topics": 100}, "reasonCodes": reasons}
}
func emptyProfile(period Object, state, recommendationState string) Object {
	basis := profileBasis(period, false, []string{recommendationState})
	basis["source"], basis["scope"], basis["doesNotIssueRecommendations"] = "issued-recommendations-and-attributed-events", "recorded-returned-candidates", true
	return Object{"profile": Object{"state": state, "interests": []any{}, "needs": []any{}, "sourceTypes": []string{}, "updatedAt": nil, "validUntil": nil, "period": period, "basis": profileBasis(period, false, []string{state})}, "recommendations": Object{"state": recommendationState, "categories": []any{}, "updatedAt": nil, "period": period, "basis": basis}}
}
func acceptedEvent(r Object, account string) Object {
	p := obj(r["payload"])
	if p == nil || r["account_id"] != account || r["profile_id"] != "account:"+account || p["accountId"] != account || p["profileId"] != r["profile_id"] || p["eventId"] != r["id"] || p["name"] != r["name"] || r["purpose"] != "site-usage-analytics" || p["purpose"] != r["purpose"] {
		return nil
	}
	input := Object{}
	for _, key := range []string{"eventId", "name", "pageKey", "content", "query", "exposureId"} {
		if v, ok := p[key]; ok {
			input[key] = v
		}
	}
	for _, key := range []string{"recommendation", "search"} {
		if v, ok := p[key]; ok {
			input[key] = Object{"requestId": obj(v)["requestId"]}
		}
	}
	event, e := discovery.ParseUsageEvent(input)
	if e != nil {
		return nil
	}
	if content := obj(event["content"]); content != nil {
		key, e := discovery.ItemKey(discovery.Reference{Kind: str(content["kind"]), ID: str(content["id"])})
		if e != nil || p["itemKey"] != key || p["sourceVersion"] != content["version"] {
			return nil
		}
	}
	event["itemKey"], event["sourceVersion"], event["at"], event["attribution"] = p["itemKey"], p["sourceVersion"], iso(r["created_at"]), obj(p["recommendation"])
	return event
}
func profileObserve(target map[string]Object, theme Object, field, at, source, method string, rec bool) {
	key := str(theme["key"])
	bucket := target[key]
	countKey := "signalCounts"
	keys := signalKeys
	if rec {
		countKey = "counts"
		keys = recommendationKeys
	}
	if bucket == nil {
		counts := Object{}
		for _, k := range keys {
			counts[k] = int64(0)
		}
		bucket = Object{"key": key, "label": theme["label"], "summary": "", "method": method, "sourceTypes": []string{}, countKey: counts, "firstObservedAt": nil, "lastObservedAt": nil}
		target[key] = bucket
	}
	counts := obj(bucket[countKey])
	counts[field] = count(counts[field]) + 1
	bucket["sourceTypes"] = appendUnique(stringsOf(bucket["sourceTypes"]), source)
	if bucket["firstObservedAt"] == nil || at < str(bucket["firstObservedAt"]) {
		bucket["firstObservedAt"] = at
	}
	if bucket["lastObservedAt"] == nil || at > str(bucket["lastObservedAt"]) {
		bucket["lastObservedAt"] = at
	}
}
func profileTopics(target map[string]Object, mode string) []Object {
	out := []Object{}
	for _, r := range target {
		c := obj(r["signalCounts"])
		if mode == "recommendations" {
			c = obj(r["counts"])
		}
		include := mode != "interests"
		if !include {
			for _, k := range signalKeys {
				if k != "searches" && k != "notInterested" && count(c[k]) > 0 {
					include = true
				}
			}
		}
		if !include {
			continue
		}
		switch mode {
		case "needs":
			r["summary"] = fmt.Sprintf("本期有 %d 次公开搜索匹配此主题", count(c["searches"]))
		case "recommendations":
			r["summary"] = fmt.Sprintf("返回候选 %d 项，已记录展示 %d 次", count(c["returnedCandidates"]), count(c["exposures"]))
		default:
			r["summary"] = fmt.Sprintf("本期浏览 %d 次、点击 %d 次、收藏 %d 次、参与 %d 次，公开发表 %d 条", count(c["views"]), count(c["clicks"]), count(c["bookmarks"]), count(c["participations"]), count(c["publicPosts"])+count(c["publicReplies"]))
		}
		out = append(out, r)
	}
	sorter := collate.New(language.SimplifiedChinese)
	sort.SliceStable(out, func(i, j int) bool {
		if cmp := sorter.CompareString(str(out[i]["label"]), str(out[j]["label"])); cmp != 0 {
			return cmp < 0
		}
		return str(out[i]["key"]) < str(out[j]["key"])
	})
	return out
}
func (s *Service) readProfile(ctx context.Context, account string, period Object, canRecommend bool) (Object, error) {
	recState := "not-authorized"
	if canRecommend {
		recState = "not-connected"
	}
	if s.Runtime == nil || s.Runtime.Source == nil || s.Runtime.Recommendations == nil {
		v := emptyProfile(period, "not-connected", recState)
		v["readExpiresAt"] = s.now() + 30
		return v, nil
	}
	var catalog, rawEvents, authored, requests []Object
	negatives := map[string]bool{}
	events := []Object{}
	reasons, recReasons := []string{}, []string{}
	_, e := postgres.InTx(ctx, s.Domain.Pool, func(tx pgx.Tx) (Object, error) {
		var e error
		catalog, e = s.Runtime.Recommendations.CatalogWithin(ctx, tx)
		if e != nil {
			return nil, e
		}
		filtered := []Object{}
		for _, theme := range catalog {
			label, ok := theme["label"].(string)
			if theme["enabled"] == true && profileThemeKey.MatchString(str(theme["key"])) && ok && protocol.TextLength(label) <= 200 {
				filtered = append(filtered, theme)
			}
		}
		catalog = filtered
		if len(catalog) > 1000 {
			return Object{}, nil
		}
		rawEvents, e = rows(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT id,account_id,profile_id,name,purpose,payload,created_at FROM discovery_usage_events_v1 WHERE endpoint=$1 AND account_id=$2 AND profile_id=$3 AND purpose='site-usage-analytics' AND created_at>=$4 AND created_at<=$5 ORDER BY created_at,id LIMIT 2001)r`, s.Domain.Endpoint, account, "account:"+account, reportDate(period["from"]), reportDate(period["to"]))
		if e != nil {
			return nil, e
		}
		authored, e = rows(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT * FROM(SELECT 'post' AS kind,id,current_version_id::text AS version,created_at FROM forum_posts_v1 WHERE account_id=$1 AND created_at>=$2 AND created_at<=$3 UNION ALL SELECT 'reply',id,revision::text,created_at FROM forum_replies_v1 WHERE account_id=$1 AND created_at>=$2 AND created_at<=$3)authored ORDER BY created_at,kind,id LIMIT 201)r`, account, reportDate(period["from"]), reportDate(period["to"]))
		if e != nil {
			return nil, e
		}
		if len(rawEvents) > 2000 {
			reasons = append(reasons, "event-window-too-large")
		}
		if len(authored) > 200 {
			reasons = append(reasons, "public-authoring-window-too-large")
		}
		eventKeys, requestIDs := []string{}, []string{}
		for i, r := range rawEvents {
			if i >= 2000 {
				break
			}
			if event := acceptedEvent(r, account); event != nil {
				events = append(events, event)
				if key := str(event["itemKey"]); key != "" {
					eventKeys = appendUnique(eventKeys, key)
				}
				if request := str(obj(event["recommendation"])["requestId"]); validID(request) {
					requestIDs = appendUnique(requestIDs, request)
				}
			}
		}
		if len(events) < len(rawEvents) && len(events) < 2000 {
			reasons = append(reasons, "unqualified-event-records-excluded")
		}
		feedback, e := rows(ctx, tx, "SELECT jsonb_build_object('key',item_key) FROM discovery_feedback_v1 WHERE endpoint=$1 AND profile_id=$2 AND negative AND item_key=ANY($3::text[])", s.Domain.Endpoint, "account:"+account, eventKeys)
		if e != nil {
			return nil, e
		}
		for _, f := range feedback {
			negatives[str(f["key"])] = true
		}
		if canRecommend {
			requests, e = rows(ctx, tx, `SELECT to_jsonb(r) FROM(SELECT id,profile_id,mode,placement,items,created_at FROM discovery_recommendation_requests_v1 WHERE endpoint=$1 AND profile_id=$2 AND ((created_at>=$3 AND created_at<=$4) OR id=ANY($5::uuid[])) ORDER BY created_at,id LIMIT 201)r`, s.Domain.Endpoint, "account:"+account, reportDate(period["from"]), reportDate(period["to"]), requestIDs)
			if e != nil {
				return nil, e
			}
		}
		return Object{}, nil
	})
	if e != nil {
		return nil, e
	}
	if len(catalog) > 1000 {
		v := emptyProfile(period, "partial", map[bool]string{true: "partial", false: "not-authorized"}[canRecommend])
		v["readExpiresAt"] = s.now() + 30
		return v, nil
	}
	if len(requests) > 200 {
		recReasons = append(recReasons, "recommendation-window-too-large")
	}
	refs := []discovery.Reference{}
	seenRefs := map[string]bool{}
	addRef := func(kind, id string) {
		ref := discovery.Reference{Kind: kind, ID: id}
		key, e := discovery.ItemKey(ref)
		if e == nil && !seenRefs[key] {
			seenRefs[key] = true
			refs = append(refs, ref)
		}
	}
	for _, event := range events {
		c := obj(event["content"])
		if c != nil {
			addRef(str(c["kind"]), str(c["id"]))
		}
	}
	for i, r := range authored {
		if i < 200 {
			addRef(str(r["kind"]), str(r["id"]))
		}
	}
	requestItems := map[string]Object{}
	requestOrder := []string{}
	for i, r := range requests {
		if i >= 200 {
			break
		}
		items, ok := r["items"].([]any)
		if !ok || len(items) > 30 || !has([]string{"personalized", "latest"}, str(r["mode"])) || r["placement"] != "home-public-recommendations" {
			recReasons = append(recReasons, "invalid-recommendation-record")
			continue
		}
		picked := map[string]Object{}
		order := []string{}
		valid := true
		for _, raw := range items {
			item := obj(raw)
			ref := discovery.ItemReference(str(item["key"]))
			position, pok := integer(item["position"])
			version := str(item["sourceVersion"])
			if ref == nil || ref.Kind != str(item["kind"]) || ref.ID != str(item["id"]) || !pok || position < 1 || position > 30 || picked[str(item["key"])] != nil || !(validID(version) || sourceRevision.MatchString(version)) || !has([]string{"gorse-recommendation", "gorse-latest"}, str(item["candidateSource"])) {
				valid = false
				break
			}
			picked[str(item["key"])] = item
			order = append(order, str(item["key"]))
			addRef(ref.Kind, ref.ID)
		}
		if valid {
			requestItems[str(r["id"])] = Object{"at": iso(r["created_at"]), "items": picked, "order": order}
			requestOrder = append(requestOrder, str(r["id"]))
		} else {
			recReasons = append(recReasons, "invalid-recommendation-record")
		}
	}
	if len(refs) > 200 {
		v := emptyProfile(period, "partial", map[bool]string{true: "partial", false: "not-authorized"}[canRecommend])
		obj(obj(v["profile"])["basis"])["reasonCodes"], obj(obj(v["recommendations"])["basis"])["reasonCodes"] = []string{"source-window-too-large"}, []string{"source-window-too-large"}
		v["readExpiresAt"] = s.now() + 30
		return v, nil
	}
	documents := map[string]*discovery.Document{}
	for pass := 0; pass < 2; pass++ {
		for _, ref := range refs {
			d, e := s.Runtime.Source.Load(ctx, ref)
			if e != nil {
				return nil, e
			}
			if pass == 1 && d != nil && d.PublishedUntil <= s.now() {
				d = nil
			}
			key, _ := discovery.ItemKey(ref)
			documents[key] = d
		}
	}
	interests, needs, categories := map[string]Object{}, map[string]Object{}, map[string]Object{}
	matches := func(d *discovery.Document) []Object {
		out := []Object{}
		for _, t := range catalog {
			if discovery.ThemeMatches(t, d) {
				out = append(out, t)
			}
		}
		return out
	}
	excluded, unmapped := int64(0), int64(0)
	for _, event := range events {
		at := str(event["at"])
		if event["name"] == "search" {
			selected := []Object{}
			for _, t := range catalog {
				if discovery.QueryMatches(t, str(event["query"])) {
					selected = append(selected, t)
				}
			}
			if len(selected) == 0 {
				unmapped++
			}
			for _, t := range selected {
				profileObserve(needs, t, "searches", at, "public-search", "explicit-query-theme-map-v1", false)
			}
			continue
		}
		if obj(event["content"]) == nil {
			continue
		}
		key := str(event["itemKey"])
		d := documents[key]
		if d == nil || d.Version != str(event["sourceVersion"]) {
			excluded++
			continue
		}
		themes := matches(d)
		field := map[string]string{"content-view": "views", "content-click": "clicks", "search-click": "clicks", "content-bookmark": "bookmarks", "content-participate": "participations", "not-interested": "notInterested"}[str(event["name"])]
		if field != "" && (!negatives[key] || field == "notInterested") {
			for _, t := range themes {
				profileObserve(interests, t, field, at, "public-content-use", "qualified-topic-observation-v1", false)
			}
		}
		attr := obj(event["attribution"])
		request := requestItems[str(attr["requestId"])]
		picked, _ := request["items"].(map[string]Object)
		item := picked[key]
		recField := map[string]string{"content-exposure": "exposures", "content-click": "clicks", "content-bookmark": "bookmarks", "content-participate": "participations", "not-interested": "notInterested"}[str(event["name"])]
		if recField != "" && item != nil && item["sourceVersion"] == event["sourceVersion"] && count(attr["position"]) == count(item["position"]) && attr["candidateSource"] == item["candidateSource"] && attr["placement"] == "home-public-recommendations" {
			for _, t := range themes {
				profileObserve(categories, t, recField, at, "recommendation-attribution", "issued-gorse-categories-v1", true)
			}
		}
	}
	for i, r := range authored {
		if i >= 200 {
			break
		}
		key, _ := discovery.ItemKey(discovery.Reference{Kind: str(r["kind"]), ID: str(r["id"])})
		d := documents[key]
		if d == nil || d.Version != str(r["version"]) || d.AuthorAccountID == nil || *d.AuthorAccountID != account {
			excluded++
			continue
		}
		field := "publicPosts"
		if r["kind"] == "reply" {
			field = "publicReplies"
		}
		for _, t := range matches(d) {
			profileObserve(interests, t, field, str(iso(r["created_at"])), "public-authoring", "qualified-topic-observation-v1", false)
		}
	}
	for _, id := range requestOrder {
		request := requestItems[id]
		at := str(request["at"])
		if at < str(period["from"]) || at > str(period["to"]) {
			continue
		}
		picked, _ := request["items"].(map[string]Object)
		for _, key := range stringsOf(request["order"]) {
			item := picked[key]
			d := documents[key]
			if d == nil || d.Version != str(item["sourceVersion"]) {
				excluded++
				continue
			}
			for _, t := range matches(d) {
				profileObserve(categories, t, "returnedCandidates", at, "gorse-returned-candidates", "issued-gorse-categories-v1", true)
			}
		}
	}
	interestRows, needRows, categoryRows := profileTopics(interests, "interests"), profileTopics(needs, "needs"), profileTopics(categories, "recommendations")
	if len(interestRows) > 100 || len(needRows) > 100 {
		reasons = append(reasons, "topic-window-too-large")
	}
	if len(categoryRows) > 100 {
		recReasons = append(recReasons, "topic-window-too-large")
	}
	complete := len(reasons) == 0
	recComplete := complete && len(recReasons) == 0
	state, rec := "partial", "not-authorized"
	if complete {
		state = "empty"
		if len(interestRows)+len(needRows) > 0 {
			state = "available"
		}
	}
	if canRecommend {
		rec = "partial"
		if recComplete {
			rec = "empty"
			if len(categoryRows) > 0 {
				rec = "available"
			}
		}
	}
	sources := []string{}
	for _, r := range append(append([]Object{}, interestRows...), needRows...) {
		sources = appendUnique(sources, stringsOf(r["sourceTypes"])...)
	}
	if len(interestRows) > 100 {
		interestRows = interestRows[:100]
	}
	if len(needRows) > 100 {
		needRows = needRows[:100]
	}
	if len(categoryRows) > 100 {
		categoryRows = categoryRows[:100]
	}
	at := s.now()
	basis := profileBasis(period, complete, appendUnique([]string{}, reasons...))
	basis["excludedSources"], basis["unmappedSearches"], basis["negativeFeedback"], basis["selfDeclared"] = excluded, unmapped, "current-item-exclusion", false
	recBasis := profileBasis(period, recComplete, appendUnique(appendUnique([]string{}, reasons...), recReasons...))
	recBasis["source"], recBasis["scope"], recBasis["doesNotIssueRecommendations"] = "issued-recommendations-and-attributed-events", "recorded-returned-candidates", true
	var updated any = stamp(time.Unix(at, 0))
	if !canRecommend {
		updated = nil
		categoryRows = []Object{}
	}
	expires := at + 30
	for _, d := range documents {
		if d != nil && d.PublishedUntil < expires {
			expires = d.PublishedUntil
		}
	}
	return Object{"profile": Object{"state": state, "interests": interestRows, "needs": needRows, "sourceTypes": sources, "updatedAt": stamp(time.Unix(at, 0)), "validUntil": nil, "period": period, "basis": basis}, "recommendations": Object{"state": rec, "categories": categoryRows, "updatedAt": updated, "period": period, "basis": recBasis}, "readExpiresAt": expires}, nil
}
func reportDate(v any) any {
	if v == nil {
		return nil
	}
	t, e := time.Parse(time.RFC3339Nano, str(v))
	if e != nil {
		return nil
	}
	return t
}
func (s *Service) Profile(ctx context.Context, a Actor, account string, input Object) (Object, error) {
	days, e := parseDays(input)
	if e != nil || !validID(account) {
		return nil, fail("invalid_business_admin_request", 400)
	}
	account = strings.ToLower(account)
	fresh, e := s.current(ctx, a, account)
	if e != nil {
		return nil, e
	}
	window, _ := period(s.now(), days)
	can := has(fresh.Permissions, "recommendations.read")
	v, e := s.readProfile(ctx, account, window, can)
	if e != nil {
		if fault.Status(e) == 401 || fault.Status(e) == 403 || fault.Code(e) == "operations_authorization_unavailable" {
			return nil, e
		}
		rec := "not-authorized"
		if can {
			rec = "unavailable"
		}
		v = emptyProfile(window, "unavailable", rec)
		v["readExpiresAt"] = s.now() + 30
	}
	current, e := s.current(ctx, fresh, account)
	if e != nil {
		return nil, e
	}
	if !has(current.Permissions, "recommendations.read") {
		v["recommendations"] = emptyProfile(window, "empty", "not-authorized")["recommendations"]
	}
	at := s.now()
	if count(v["readExpiresAt"]) <= at {
		rec := "not-authorized"
		if has(current.Permissions, "recommendations.read") {
			rec = "unavailable"
		}
		v = emptyProfile(window, "unavailable", rec)
		v["readExpiresAt"] = at + 30
	}
	expires := count(v["readExpiresAt"])
	if expires > at+30 {
		expires = at + 30
	}
	return Object{"accountId": account, "days": days, "period": window, "checkedAt": at, "readExpiresAt": expires, "metadataOnly": true, "profile": v["profile"], "recommendations": v["recommendations"]}, nil
}
