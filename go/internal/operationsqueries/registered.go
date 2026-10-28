package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"regexp"
	"slices"
	"time"
	"unicode/utf16"
)

var extensionControls = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f]`)
var extensionID = regexp.MustCompile(`(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

// Owning Go DTOs may hold nullable pointers or typed slices. Project the same
// JSON values their real HTTP serializer exposes, without copying authority.
func queryWireSource(value Object) (Object, error) {
	raw, e := protocol.Encode(value)
	if e != nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	var out Object
	if protocol.Decode(raw, &out) != nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	return out, nil
}

func extensionText(v any, max int) any {
	s, ok := v.(string)
	if !ok || len(utf16.Encode([]rune(s))) > max || extensionControls.MatchString(s) {
		return nil
	}
	return s
}
func extensionOne(v any, values ...string) any {
	if s, ok := v.(string); ok && slices.Contains(values, s) {
		return s
	}
	return nil
}
func extensionBool(v any) any {
	if b, ok := v.(bool); ok {
		return b
	}
	return nil
}
func extensionUUID(v any) any {
	if s, ok := v.(string); ok && extensionID.MatchString(s) {
		return s
	}
	return nil
}
func extensionISO(v any) any {
	if s, ok := v.(string); ok {
		if t, e := time.Parse(time.RFC3339Nano, s); e == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	return nil
}
func extensionArray(v any, max int) ([]any, error) {
	items, ok := v.([]any)
	if !ok {
		if rows, yes := v.([]Object); yes {
			items = []any{}
			for _, row := range rows {
				items = append(items, row)
			}
			ok = true
		}
	}
	if !ok || len(items) > max {
		return nil, fail("operations_query_response_invalid", 503)
	}
	return items, nil
}
func registeredItem(row Object) (Object, error) {
	if row == nil || extensionUUID(row["registrationId"]) == nil || object(row["identity"]) == nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	identity := object(row["identity"])
	var business any
	if b := object(row["business"]); b != nil {
		restriction := object(b["restriction"])
		business = Object{"accountId": extensionUUID(b["accountId"]), "uid": extensionText(b["uid"], 80), "displayName": extensionText(b["displayName"], 120), "subjectType": extensionOne(b["subjectType"], "person", "organization", "agent"), "businessCreatedAt": extensionISO(b["businessCreatedAt"]), "participation": Object{"restricted": extensionBool(restriction["active"]), "until": extensionISO(restriction["until"])}}
	}
	return Object{"registrationId": row["registrationId"], "identity": Object{"source": "keycloak-website", "displayName": extensionText(identity["displayName"], 240), "enabled": extensionBool(identity["enabled"]), "emailVerified": extensionBool(identity["emailVerified"]), "registeredAt": extensionISO(identity["registeredAt"]), "presence": extensionOne(identity["presence"], "present", "not-found", "outside-configured-issuer", "unavailable", "not-configured")}, "business": business, "stage": Object{"state": extensionOne(object(row["stage"])["state"], "registered", "completion-required", "unknown")}, "observedAt": extensionISO(row["observedAt"])}, nil
}
func registeredPage(value Object, filter string) (Object, error) {
	populations := map[string]string{"all": "website-registrations-and-business-only-accounts", "registered": "configured-website-registration-directory", "business-only": "business-accounts-absent-from-current-registration-directory"}
	if filter == "" {
		filter = "all"
	}
	source, pagination := object(value["source"]), object(value["pagination"])
	if populations[filter] == "" || source == nil || pagination == nil {
		return nil, fail("operations_query_response_invalid", 503)
	}
	rows, e := extensionArray(value["items"], 100)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range rows {
		item, e := registeredItem(object(v))
		if e != nil {
			return nil, e
		}
		items = append(items, item)
	}
	pages := Object{}
	for _, key := range []string{"page", "pageSize", "total", "matchingTotal", "totalPages"} {
		pages[key] = safeInteger(pagination[key])
	}
	return Object{"items": items, "pagination": pages, "source": Object{"state": extensionOne(source["state"], "ready", "syncing", "not-configured", "unavailable"), "generationId": extensionUUID(source["generationId"]), "registeredAsOf": extensionISO(source["registeredAsOf"]), "syncStartedAt": extensionISO(source["syncStartedAt"]), "coverage": extensionOne(source["coverage"], "complete-generation", "not-ready"), "atomicSourceSnapshot": false, "registeredCount": safeInteger(source["registeredCount"])}, "basis": Object{"population": populations[filter], "selectedSource": filter, "registeredCountScope": "current-website-registered-identities", "paginationCountScope": "selected-directory-source", "counts": "complete-generation", "identityFields": "email-issuer-subject-excluded", "businessCreatedAtIsRegistration": false}}, nil
}
func (s *Service) registered(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if duty := s.Permissions.Duty; duty != nil && duty.AcceptsDuty(a) {
		return queryResult{}, fail("business_admin_denied", 403)
	}
	if s.RegisteredUsers == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	// The facade shares actual directory/accounts/clock, with the owning opaque
	// read authority. It cannot execute commands or reconstruct a human session.
	live := s.RegisteredUsers
	source := &registeredusers.Service{Pool: live.Pool, Endpoint: live.Endpoint, Authority: s.reader(a), Directory: live.Directory, Portal: live.Portal, Accounts: live.Accounts, Now: live.Now}
	if args.kind != "" {
		value, e := source.Detail(ctx, a, args.id)
		if e != nil {
			return queryResult{}, e
		}
		value, e = queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		data, e := registeredItem(object(value["item"]))
		if e != nil {
			return queryResult{}, e
		}
		row := merge(data)
		row["displayName"] = object(data["business"])["displayName"]
		if row["displayName"] == nil {
			row["displayName"] = object(data["identity"])["displayName"]
		}
		return queryResult{source: value, data: data, refs: []reference{{kind: "registered-user", id: args.id, row: row, filters: args.filters}}}, nil
	}
	value, e := source.List(ctx, a, args.filters)
	if e != nil {
		return queryResult{}, e
	}
	value, e = queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	data, e := registeredPage(value, str(args.filters["source"]))
	if e != nil {
		return queryResult{}, e
	}
	ready := object(data["source"])["coverage"] == "complete-generation"
	refs := []reference{}
	if ready {
		for _, v := range data["items"].([]any) {
			row := merge(object(v))
			row["displayName"] = object(row["business"])["displayName"]
			if row["displayName"] == nil {
				row["displayName"] = object(row["identity"])["displayName"]
			}
			refs = append(refs, reference{kind: "registered-user", id: str(row["registrationId"]), row: row})
		}
	}
	page, pages := object(data["pagination"])["page"], object(data["pagination"])["totalPages"]
	p, ok := number(page)
	total, valid := number(pages)
	next := ready && ok && valid && p < total
	var resume any
	if next {
		resume = Object{"module": args.module, "view": args.view, "filters": merge(args.filters, Object{"page": p + 1})}
	}
	availability := "unavailable"
	if ready {
		availability = "available"
	} else if object(data["source"])["state"] == "not-configured" {
		availability = "not-configured"
	}
	return queryResult{source: value, data: data, refs: refs, availability: availability, pagination: Object{"next": resume, "complete": ready && !next}}, nil
}
