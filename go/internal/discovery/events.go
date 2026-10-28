package discovery

import (
	"context"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
)

var eventNames = map[string]bool{"pageview": true, "content-view": true, "content-click": true, "content-exposure": true, "content-bookmark": true, "content-participate": true, "search": true, "search-click": true, "not-interested": true}
var revisionVersion = regexp.MustCompile(`^[1-9][0-9]{0,9}$`)

func parseEvent(input Object) (Object, error) {
	if !onlyKeys(input, "eventId", "name", "pageKey", "content", "query", "exposureId", "recommendation", "search") || !validID(str(input, "eventId")) || !eventNames[str(input, "name")] || pagePaths[str(input, "pageKey")] == "" {
		return nil, invalid()
	}
	out := Object{"eventId": input["eventId"], "name": input["name"], "pageKey": input["pageKey"]}
	for _, key := range []string{"exposureId"} {
		if value, present := input[key]; present {
			v, ok := value.(string)
			if !ok || !validID(v) {
				return nil, invalid()
			}
			out[key] = v
		}
	}
	if value, present := input["query"]; present {
		v, ok := value.(string)
		if !ok {
			return nil, invalid()
		}
		v = strings.TrimFunc(v, jsSpace)
		if codePointLength(v) > 160 {
			return nil, invalid()
		}
		out["query"] = v
	}
	for _, key := range []string{"recommendation", "search"} {
		if value, present := input[key]; present {
			ref := object(value)
			if ref == nil || !onlyKeys(ref, "requestId") || !validID(str(ref, "requestId")) {
				return nil, invalid()
			}
			out[key] = Object{"requestId": ref["requestId"]}
		}
	}
	if value, present := input["content"]; present {
		ref := object(value)
		if ref == nil || !onlyKeys(ref, "kind", "id", "version") {
			return nil, invalid()
		}
		if _, e := ItemKey(Reference{Kind: str(ref, "kind"), ID: str(ref, "id")}); e != nil {
			return nil, invalid()
		}
		version, ok := ref["version"].(string)
		if !ok || !validID(version) && !revisionVersion.MatchString(version) {
			return nil, invalid()
		}
		out["content"] = Object{"kind": ref["kind"], "id": ref["id"], "version": version}
	}
	name, page := str(out, "name"), str(out, "pageKey")
	_, hasContent := out["content"]
	content := strings.HasPrefix(name, "content-") || name == "search-click" || name == "not-interested"
	_, hasQuery := out["query"]
	contains := func(values []string, v string) bool {
		for _, candidate := range values {
			if v == candidate {
				return true
			}
		}
		return false
	}
	pages := map[string][]string{"content-view": {"community"}, "content-click": {"home", "community", "find"}, "content-exposure": {"home", "community", "find"}, "content-bookmark": {"community"}, "content-participate": {"community"}, "search-click": {"find"}, "not-interested": {"home", "community", "find"}}
	if content != hasContent || (name == "search") != hasQuery || name == "search" && page != "find" || hasContent && !contains(pages[name], page) || out["exposureId"] != nil && !contains([]string{"content-exposure", "content-click", "search-click", "not-interested"}, name) || out["recommendation"] != nil && !contains([]string{"content-exposure", "content-click", "content-bookmark", "content-participate", "not-interested"}, name) || out["search"] != nil && (!contains([]string{"search", "search-click", "content-bookmark", "content-participate"}, name) || out["recommendation"] != nil) {
		return nil, qualityFailure("discovery_purpose_denied", 400)
	}
	out["purpose"] = "site-usage-analytics"
	if contains([]string{"content-view", "content-click", "content-bookmark", "content-participate", "search-click", "not-interested"}, name) {
		out["recommendationPurpose"] = "public-community-recommendation"
	}
	return out, nil
}

type UsageIdentity struct {
	AccountID, VisitorID string
	Authorization        accounts.Authorization
}

func (r *Runtime) identity(ctx context.Context, input UsageIdentity) (Object, error) {
	if !validID(input.VisitorID) || input.AccountID != "" && !validID(input.AccountID) {
		return nil, qualityFailure("discovery_identity_required", 401)
	}
	var account any
	profile := "visitor:" + input.VisitorID
	if input.AccountID != "" {
		if input.Authorization == nil {
			return nil, qualityFailure("discovery_identity_required", 401)
		}
		tx, e := r.Store.Pool.Begin(ctx)
		if e != nil {
			return nil, e
		}
		defer tx.Rollback(context.Background())
		if e = input.Authorization.Account(ctx, tx, r.Store.Endpoint, input.AccountID); e != nil {
			return nil, e
		}
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", input.AccountID, r.Store.Endpoint).Scan(&exists); e != nil {
			return nil, e
		}
		if !exists {
			return nil, qualityFailure("discovery_identity_required", 401)
		}
		if e = tx.Commit(ctx); e != nil {
			return nil, e
		}
		account = input.AccountID
		profile = "account:" + input.AccountID
	}
	return Object{"accountId": account, "visitorId": input.VisitorID, "profileId": profile}, nil
}

func (r *Runtime) RecordUsage(ctx context.Context, identity UsageIdentity, input Object, userAgent string) (Object, error) {
	event, e := parseEvent(input)
	if e != nil {
		return nil, e
	}
	owner, e := r.identity(ctx, identity)
	if e != nil {
		return nil, e
	}
	var document *Document
	if content := object(event["content"]); content != nil {
		document, e = r.Source.Load(ctx, Reference{Kind: str(content, "kind"), ID: str(content, "id")})
		if e != nil {
			return nil, e
		}
		if document == nil || document.Version != str(content, "version") {
			return nil, qualityFailure("discovery_source_unavailable", 404)
		}
	}
	if recommendation := object(event["recommendation"]); recommendation != nil {
		if r.Recommendations == nil {
			return nil, fail("discovery_recommendation_attribution_unavailable")
		}
		evidence, e := r.Recommendations.Evidence(ctx, str(owner, "profileId"), object(event["content"]), str(recommendation, "requestId"))
		if e != nil {
			return nil, e
		}
		event["recommendation"] = evidence
	}
	if event["search"] != nil {
		if r.SearchQuality == nil {
			return nil, fail("discovery_search_attribution_unavailable")
		}
		evidence, e := r.SearchQuality.Evidence(ctx, str(owner, "profileId"), event)
		if e != nil {
			return nil, e
		}
		if str(event, "name") == "search" {
			event["eventId"] = evidence["requestId"]
		}
		event["search"] = evidence
	}
	merge(event, owner)
	event["occurredAt"] = iso(r.now())
	if asciiUserAgent(userAgent) {
		event["transport"] = Object{"kind": "website-http", "userAgent": userAgent}
	}
	if document != nil {
		event["itemKey"] = document.ID
		event["sourceVersion"] = document.Version
		event["topic"] = document.Topic
	}
	return r.Store.Record(ctx, event)
}
