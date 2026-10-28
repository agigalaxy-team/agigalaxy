package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"slices"
)

var settingsPurposes = []string{"operations", "account-authentication", "runtime-alerts"}

func settingsCurrent(value any) ([]any, error) {
	if value == nil {
		value = []any{}
	}
	rows, e := extensionArray(value, 20)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range rows {
		r := object(v)
		items = append(items, Object{"target": extensionOne(r["target"], "operations", "account-authentication", "runtime-alerts", "api", "worker", "analysis", "recommendation", "search", "ai-execution", "file-scanning", "operations-worker", "operations-api", "website-authentication", "management-authentication"), "state": extensionOne(r["state"], "configured", "not-configured", "unavailable", "unknown"), "adoptedVersionId": extensionUUID(r["adoptedVersionId"]), "connectionId": extensionUUID(r["connectionId"]), "source": extensionOne(r["source"], "operations-database", "native-keycloak", "native-alertmanager", "protected-runtime", "consumer-ack", "not-connected"), "configured": extensionBool(r["configured"])})
	}
	return items, nil
}
func settingsCommon(value Object) (Object, error) {
	if value == nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	var version, pending any
	if v := object(value["version"]); v != nil {
		version = Object{"id": extensionUUID(v["id"]), "revision": safeInteger(v["revision"]), "createdAt": extensionISO(v["createdAt"])}
	}
	if p := object(value["pending"]); p != nil {
		pending = Object{"kind": extensionOne(p["kind"], "save", "test", "apply", "credential"), "state": extensionOne(p["state"], "accepted", "completed", "partial", "failed", "unknown"), "versionId": extensionUUID(p["versionId"]), "revision": safeInteger(p["revision"])}
	}
	current, e := settingsCurrent(value["current"])
	if e != nil {
		return nil, e
	}
	return Object{"revision": safeInteger(value["revision"]), "version": version, "configurationBasis": extensionOne(value["configurationBasis"], "saved-version", "observed-current", "empty"), "availability": Object{"state": extensionOne(object(value["availability"])["state"], "available", "unavailable", "not-configured")}, "current": current, "pending": pending}, nil
}
func settingsCredential(value Object, id any) any {
	connectionID, ok := id.(string)
	if !ok {
		return nil
	}
	rows, _ := extensionArray(value["credentials"], 100000)
	for _, v := range rows {
		r := object(v)
		if candidate, ok := r["connectionId"].(string); ok && candidate == connectionID {
			return extensionBool(r["configured"])
		}
	}
	return nil
}
func settingsOrigin(value any) any {
	s, ok := value.(string)
	if !ok {
		return nil
	}
	u, e := whatwg.Parse(s)
	if e != nil || u.Username() != "" || u.Password() != "" || u.Search() != "" || u.Hash() != "" || u.Pathname() != "" && u.Pathname() != "/" || u.Scheme() != "https" && (u.Scheme() != "http" || !slices.Contains([]string{"127.0.0.1", "localhost", "[::1]"}, u.Hostname())) {
		return nil
	}
	return u.Scheme() + "://" + u.Host()
}
func systemMail(value Object) (Object, error) {
	configuration := object(value["configuration"])
	if configuration == nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	common, e := settingsCommon(value)
	if e != nil {
		return nil, e
	}
	rows, e := extensionArray(configuration["connections"], 16)
	if e != nil {
		return nil, e
	}
	connections := []any{}
	for _, v := range rows {
		r := object(v)
		connections = append(connections, Object{"id": extensionUUID(r["id"]), "name": extensionText(r["name"], 100), "host": extensionText(r["host"], 253), "port": safeInteger(r["port"]), "tls": extensionOne(r["tls"], "implicit", "starttls"), "credentialsConfigured": settingsCredential(value, r["id"])})
	}
	bindings := Object{}
	for _, key := range settingsPurposes {
		bindings[key] = extensionUUID(object(configuration["bindings"])[key])
	}
	return merge(Object{"section": "mail"}, common, Object{"configuration": Object{"connections": connections, "bindings": bindings}, "basis": "saved-or-observed-mail-configuration-and-current-consumer-ack"}), nil
}
func systemConnections(value Object) (Object, error) {
	configuration := object(value["configuration"])
	if configuration == nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	common, e := settingsCommon(value)
	if e != nil {
		return nil, e
	}
	rows, e := extensionArray(configuration["connections"], 5)
	if e != nil {
		return nil, e
	}
	connections := []any{}
	for _, v := range rows {
		r := object(v)
		var origin, index, scanner, credentials any
		if r["kind"] == "file-scanning" {
			scanner = Object{"host": extensionOne(r["host"], "127.0.0.1", "::1", "localhost"), "port": safeInteger(r["port"]), "timeoutMs": safeInteger(r["timeoutMs"])}
		} else {
			origin = settingsOrigin(r["url"])
			credentials = settingsCredential(value, r["id"])
		}
		if r["kind"] == "search" {
			index = extensionText(r["index"], 80)
		}
		connections = append(connections, Object{"id": extensionUUID(r["id"]), "kind": extensionOne(r["kind"], "analysis", "recommendation", "search", "ai-execution", "file-scanning"), "origin": origin, "index": index, "scanner": scanner, "credentialsConfigured": credentials})
	}
	return merge(Object{"section": "service-connections"}, common, Object{"configuration": Object{"connections": connections}, "basis": "saved-or-observed-service-configuration-and-current-consumer-ack"}), nil
}
func systemAdvanced(value Object) (Object, error) {
	if value == nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	rows, e := extensionArray(value["connections"], 16)
	if e != nil {
		return nil, e
	}
	connections := []any{}
	for _, v := range rows {
		r := object(v)
		item := Object{"id": extensionUUID(r["id"]), "name": extensionText(r["name"], 100), "dkimSelector": extensionText(r["dkimSelector"], 63)}
		for _, key := range []string{"connectionTimeoutMs", "greetingTimeoutMs", "socketTimeoutMs", "maxConnections", "rateLimit", "rateWindowSeconds"} {
			item[key] = safeInteger(r[key])
		}
		connections = append(connections, item)
	}
	current, e := settingsCurrent(value["current"])
	if e != nil {
		return nil, e
	}
	return Object{"section": "advanced", "revision": safeInteger(value["revision"]), "versionId": extensionUUID(value["versionId"]), "connections": connections, "source": extensionOne(value["source"], "mail-configuration"), "limitsScope": extensionOne(value["limitsScope"], "per-worker-process"), "current": current}, nil
}
func systemGeneral(value Object) (Object, error) {
	publication := object(value["publication"])
	if publication == nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	var configuration any
	if c := object(value["configuration"]); publication["state"] == "available" && c != nil {
		rows, e := extensionArray(c["footerLinks"], 24)
		if e != nil {
			return nil, e
		}
		links := []any{}
		for _, v := range rows {
			r := object(v)
			links = append(links, Object{"label": extensionText(r["label"], 120), "href": extensionText(r["href"], 2048)})
		}
		configuration = Object{"siteTitle": extensionText(c["siteTitle"], 200), "description": extensionText(c["description"], 1600), "footerLinks": links}
	}
	return Object{"section": "general", "publication": Object{"id": extensionUUID(publication["id"]), "state": extensionOne(publication["state"], "available", "unavailable")}, "configuration": configuration, "basis": "current-public-website-publication", "savedDraft": Object{"state": "not-read", "configuration": nil}, "logo": Object{"source": "fixed-brand-asset", "canReplace": false}, "favicon": Object{"source": "fixed-brand-asset", "canReplace": false}}, nil
}
func settingsLease(values ...Object) (Object, error) {
	if len(values) == 0 {
		return nil, fail("operations_query_response_invalid", 503)
	}
	start, end := float64(0), float64(9007199254740991)
	for _, v := range values {
		a, b := safeInteger(v["checkedAt"]), safeInteger(v["readExpiresAt"])
		if a == nil || b == nil {
			return nil, fail("operations_query_response_invalid", 503)
		}
		x, y := a.(float64), b.(float64)
		if y < x {
			return nil, fail("operations_query_response_invalid", 503)
		}
		start, end = max(start, x), min(end, y)
	}
	return Object{"checkedAt": start, "readExpiresAt": end, "metadataOnly": true}, nil
}
func (s *Service) settings(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if duty := s.Permissions.Duty; duty != nil && duty.AcceptsDuty(a) {
		return queryResult{}, fail("system_settings_permission_denied", 403)
	}
	if s.SystemSettings == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	live := s.SystemSettings
	// Explicit read facade: preserve native/stored dependencies without copying
	// reconciliation mutex/state or substituting a human gateway for AI purpose.
	source := &systemsettings.Service{Pool: live.Pool, Endpoint: live.Endpoint, Authority: s.reader(a), StoredAuthority: live.StoredAuthority, Native: live.Native, Now: live.Now}
	general := func() (Object, error) {
		if s.SystemGeneral == nil {
			return nil, fail("operations_query_not_configured", 503)
		}
		g := s.SystemGeneral
		reader := &systemsettings.General{Settings: source, Publications: g.Publications, WebsiteOrigin: g.WebsiteOrigin, Client: g.Client}
		return reader.PublishedGeneral(ctx, a)
	}
	if args.view == "general" {
		value, e := general()
		if e != nil {
			return queryResult{}, e
		}
		data, e := systemGeneral(value)
		ready := object(value["publication"])["state"] == "available"
		availability := "unavailable"
		if ready {
			availability = "available"
		}
		return queryResult{source: value, data: data, availability: availability, pagination: Object{"next": nil, "complete": ready}}, e
	}
	if args.view == "advanced" {
		value, e := source.Advanced(ctx, a)
		if e != nil {
			return queryResult{}, e
		}
		data, e := systemAdvanced(value)
		return queryResult{source: value, data: data}, e
	}
	if args.view == "overview" {
		current, e := source.Overview(ctx, a)
		if e != nil {
			return queryResult{}, e
		}
		published, e := general()
		if e != nil {
			return queryResult{}, e
		}
		mail, connections := object(object(current["sections"])["mail"]), object(object(current["sections"])["service-connections"])
		if mail == nil || connections == nil {
			return queryResult{}, fail("operations_query_response_invalid", 503)
		}
		mailData, e := systemMail(mail)
		if e != nil {
			return queryResult{}, e
		}
		connectionData, e := systemConnections(connections)
		if e != nil {
			return queryResult{}, e
		}
		generalData, e := systemGeneral(published)
		if e != nil {
			return queryResult{}, e
		}
		advanced, e := systemAdvanced(Object{"revision": mail["revision"], "versionId": object(mail["version"])["id"], "connections": object(mail["configuration"])["connections"], "source": "mail-configuration", "limitsScope": "per-worker-process", "current": mail["current"]})
		if e != nil {
			return queryResult{}, e
		}
		lease, e := settingsLease(current, mail, connections, published)
		if e != nil {
			return queryResult{}, e
		}
		return queryResult{source: lease, data: Object{"sections": Object{"general": generalData, "mail": mailData, "service-connections": connectionData, "advanced": advanced}, "basis": "current-safe-section-reads-general-published-only"}}, nil
	}
	value, e := source.Read(ctx, a, args.view)
	if e != nil {
		return queryResult{}, e
	}
	var data Object
	if args.view == "mail" {
		data, e = systemMail(value)
	} else {
		data, e = systemConnections(value)
	}
	return queryResult{source: value, data: data}, e
}
