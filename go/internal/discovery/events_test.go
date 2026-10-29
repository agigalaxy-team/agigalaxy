package discovery

import (
	"strings"
	"testing"
)

func TestClosedEventPurposesAndNoCallerIdentity(t *testing.T) {
	id, version := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	allowed := map[string][]string{
		"pageview":     {"home", "community", "find", "account", "help", "download"},
		"content-view": {"community"}, "content-bookmark": {"community"}, "content-participate": {"community"},
		"content-click": {"home", "community", "find"}, "content-exposure": {"home", "community", "find"},
		"not-interested": {"home", "community", "find"}, "search": {"find"}, "search-click": {"find"},
	}
	for name := range eventNames {
		for page := range pagePaths {
			input := Object{"eventId": id, "name": name, "pageKey": page}
			if strings.HasPrefix(name, "content-") || name == "search-click" || name == "not-interested" {
				input["content"] = Object{"kind": "post", "id": id, "version": version}
			}
			if name == "search" {
				input["query"] = " \ufeff Go \u00a0 "
			}
			accepted := false
			for _, value := range allowed[name] {
				accepted = accepted || page == value
			}
			value, err := parseEvent(input)
			if !accepted {
				if errorCode(err) != "discovery_purpose_denied" {
					t.Fatalf("event purpose %s/%s: %v", name, page, err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("allowed event %s/%s: %v", name, page, err)
			}
			expected := merge(Object{}, input)
			expected["purpose"] = "site-usage-analytics"
			if name == "search" {
				expected["query"] = "Go"
			}
			if name != "pageview" && name != "search" && name != "content-exposure" {
				expected["recommendationPurpose"] = "public-community-recommendation"
			}
			if !sameValue(value, expected) {
				t.Fatalf("bounded event %s/%s: %s", name, page, jsonString(value))
			}
		}
	}
	base := Object{"eventId": id, "name": "pageview", "pageKey": "home"}
	for _, key := range []string{"accountId", "visitorId", "profileId", "purpose", "transport", "body", "title", "url", "privateMessages"} {
		input := merge(Object{}, base)
		input[key] = "caller-data"
		if _, err := parseEvent(input); errorCode(err) != "invalid_discovery_request" {
			t.Fatalf("caller identity or content %s accepted: %v", key, err)
		}
	}
	for _, row := range []struct {
		change Object
		code   string
	}{
		{Object{"query": "unexpected"}, "discovery_purpose_denied"},
		{Object{"content": nil}, "invalid_discovery_request"},
		{Object{"eventId": "invalid"}, "invalid_discovery_request"},
		{Object{"pageKey": "unknown"}, "invalid_discovery_request"},
		{Object{"exposureId": id}, "discovery_purpose_denied"},
		{Object{"search": Object{"requestId": id}}, "discovery_purpose_denied"},
		{Object{"recommendation": Object{"requestId": id}}, "discovery_purpose_denied"},
	} {
		if _, err := parseEvent(merge(merge(Object{}, base), row.change)); errorCode(err) != row.code {
			t.Fatalf("closed event %s: %v", jsonString(row.change), err)
		}
	}
}
