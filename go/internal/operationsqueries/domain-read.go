package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsresources"
)

func typedList(args arguments, value Object, projector func(Object) Object, kind func(Object) string) (queryResult, error) {
	source, e := queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	items, e := extensionArray(source["items"], 100000)
	if e != nil {
		return queryResult{}, e
	}
	rows, refs := []any{}, []reference{}
	for _, v := range items {
		x := object(v)
		rows = append(rows, projector(x))
		if kind != nil {
			if k := kind(x); k != "" {
				id := str(x["id"])
				for _, key := range []string{"accountId", "reportId", "runId"} {
					if id == "" {
						id = str(x[key])
					}
				}
				refs = append(refs, reference{kind: k, id: id, row: x})
			}
		}
	}
	var resume any
	if next := source["nextAfter"]; next != nil && next != "" {
		resume = Object{"module": args.module, "view": args.view, "filters": merge(args.filters, Object{"after": next})}
	}
	complete := resume == nil && source["scanTruncated"] != true && source["scanLimited"] != true
	data := Object{"items": rows, "coverage": "returned-page", "scanLimited": source["scanTruncated"] == true || source["scanLimited"] == true}
	if availability := object(source["availability"]); availability != nil {
		data["availability"] = project(availability, shape("state code", "s"))
		if availability["state"] != nil && availability["state"] != "available" {
			complete = false
		}
	}
	return queryResult{source: source, data: data, refs: refs, pagination: Object{"next": resume, "complete": complete}}, nil
}
func fixedKind(kind string) func(Object) string { return func(Object) string { return kind } }

var visibilityShape = merge(shape("hidden ownHidden inheritedHidden caseHidden", "b"), Object{"version": "n", "until": "s"})

func publicVisible(x Object) bool {
	return x["sourceState"] == "available" && object(x["visibility"])["hidden"] == false
}
func utf16Preview(v any, max int) (any, bool) {
	s, ok := v.(string)
	if !ok {
		return nil, false
	}
	out, n := "", 0
	for _, r := range s {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if n+size > max {
			return out, true
		}
		out += string(r)
		n += size
	}
	return out, false
}
func contentItem(x Object, body bool) Object {
	readable := publicVisible(x)
	out := object(project(x, merge(shape("kind id postId versionId state sourceState createdAt updatedAt", "s"), Object{"version": "n", "visibility": visibilityShape, "curation": merge(shape("revision sourceVersion", "n"), shape("appliesToCurrent pinned featured", "b"), Object{"topic": "s", "tags": []any{merge(shape("id name", "s"), Object{"version": "n", "enabled": "b"})}})})))
	for _, key := range []string{"title", "excerpt", "topic", "originalTopic"} {
		out[key] = nil
		if readable {
			out[key] = text(x[key])
		}
	}
	out["author"] = nil
	if readable {
		out["author"] = project(x["author"], accountShape)
	}
	out["publiclyReadable"] = readable
	if body {
		out["body"], out["bodyTruncated"] = nil, false
		if readable {
			out["body"], out["bodyTruncated"] = utf16Preview(x["body"], 12000)
		}
	}
	return out
}
func sectionItem(x Object) Object {
	out := object(project(x, merge(shape("id state sourceState category createdAt updatedAt", "s"), Object{"version": "n", "visibility": visibilityShape})))
	out["title"] = nil
	if publicVisible(x) {
		out["title"] = text(x["title"])
	}
	return out
}
func resourceItem(x Object) Object {
	out := object(project(x, merge(shape("id kind state sourceState createdAt updatedAt", "s"), Object{"version": "n", "visibility": visibilityShape}, shape("deprecated securityIssue", "b"))))
	out["title"] = nil
	if publicVisible(x) {
		out["title"] = text(x["title"])
	}
	return out
}
func (s *Service) community(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Community == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	live := s.Community
	reader := &operationscommunity.Service{Pool: live.Pool, Endpoint: live.Endpoint, Authority: s.reader(a), Duty: live.Duty, PrincipalWithin: live.PrincipalWithin, ReadPrincipalWithin: live.ReadPrincipalWithin, Forum: live.Forum, Files: live.Files, Links: live.Links, Now: live.Now}
	var value Object
	var e error
	if args.kind != "" {
		switch args.kind {
		case "post", "reply":
			value, e = reader.Content(ctx, a, args.kind, args.id, Object{})
		case "section":
			value, e = reader.Section(ctx, a, args.id)
		case "case":
			value, e = reader.Report(ctx, a, args.id)
		default:
			return queryResult{}, invalid()
		}
		if e != nil {
			return queryResult{}, e
		}
		value, e = queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		row := value
		var data Object
		purpose := ""
		if args.kind == "post" || args.kind == "reply" {
			row = object(value["content"])
			data = contentItem(row, true)
		} else if args.kind == "section" {
			data = sectionItem(row)
		} else {
			if row["id"] != args.id {
				return queryResult{}, fail("operations_query_response_invalid", 503)
			}
			data, e = caseDetail(row)
			purpose = "public-case-review"
		}
		return queryResult{source: value, data: data, purpose: purpose, refs: []reference{{kind: args.kind, id: args.id, row: row, filters: args.filters, purpose: purpose}}}, e
	}
	if args.module == "cases" {
		value, e = reader.Reports(ctx, a, args.filters)
		if e != nil {
			return queryResult{}, e
		}
		return typedList(args, value, caseItem, fixedKind("case"))
	}
	switch args.view {
	case "sections":
		value, e = reader.Sections(ctx, a, args.filters)
		if e != nil {
			return queryResult{}, e
		}
		return typedList(args, value, sectionItem, fixedKind("section"))
	case "tags":
		value, e = reader.Tags(ctx, a)
		if e != nil {
			return queryResult{}, e
		}
		source, e := queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		items, e := extensionArray(source["items"], 100000)
		if e != nil {
			return queryResult{}, e
		}
		rows := []any{}
		for _, x := range items {
			rows = append(rows, project(x, merge(shape("id name", "s"), Object{"enabled": "b", "version": "n"})))
		}
		return queryResult{source: source, data: Object{"items": rows}}, nil
	case "list":
		q := merge(args.filters)
		if str(q["query"]) != "" {
			q["visibility"] = "visible"
		}
		value, e = reader.Contents(ctx, a, q)
		if e != nil {
			return queryResult{}, e
		}
		out, e := typedList(args, value, func(x Object) Object { return contentItem(x, false) }, func(x Object) string { return str(x["kind"]) })
		if e != nil {
			return queryResult{}, e
		}
		out.data["summary"] = project(out.source["summary"], merge(Object{"available": "b"}, shape("state reason", "s"), shape("total visible hidden unavailable posts replies pendingReview trendDays", "n"), Object{"daily": []any{merge(Object{"date": "s"}, shape("posts replies", "n"))}}))
		return out, nil
	}
	return queryResult{}, invalid()
}
func (s *Service) resources(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Resources == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	x := s.Resources
	reader := &operationsresources.Service{Pool: x.Pool, Endpoint: x.Endpoint, Authority: s.reader(a), Duty: x.Duty, PrincipalWithin: x.PrincipalWithin, Projects: x.Projects, Capsules: x.Capsules, MaxHideSeconds: x.MaxHideSeconds, MaxHideSecondsNow: x.MaxHideSecondsNow, Now: x.Now}
	if args.kind != "" {
		kind := "projects"
		if args.kind == "method" {
			kind = "methods"
		}
		value, e := reader.Get(ctx, a, kind, args.id)
		if e != nil {
			return queryResult{}, e
		}
		value, e = queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		return queryResult{source: value, data: resourceItem(value), refs: []reference{{kind: args.kind, id: args.id, row: value, filters: args.filters}}}, nil
	}
	value, e := reader.List(ctx, a, args.view, args.filters)
	if e != nil {
		return queryResult{}, e
	}
	kind := "project"
	if args.view == "methods" {
		kind = "method"
	}
	return typedList(args, value, resourceItem, fixedKind(kind))
}
func (s *Service) files(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Files == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	x := s.Files
	reader := &filegovernance.Service{Pool: x.Pool, Endpoint: x.Endpoint, Authority: s.reader(a), Duty: x.Duty, StoredAuthority: x.StoredAuthority, PrincipalWithin: x.PrincipalWithin, Chat: x.Chat, Forum: x.Forum, Now: x.Now, Diagnostic: x.Diagnostic}
	var value Object
	var e error
	if args.kind != "" {
		switch args.kind {
		case "chat-file", "forum-file":
			kind := "chat"
			if args.kind == "forum-file" {
				kind = "forum"
			}
			value, e = reader.Get(ctx, a, kind, args.id)
		case "file-cleanup-plan":
			value, e = reader.CleanupPlan(ctx, a, args.id)
		case "file-cleanup-operation":
			value, e = reader.CleanupOperation(ctx, a, args.id)
		default:
			return queryResult{}, invalid()
		}
		if e != nil {
			return queryResult{}, e
		}
		value, e = queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		data := fileItem(value)
		if args.kind == "file-cleanup-plan" {
			data = cleanupPlanItem(value)
		} else if args.kind == "file-cleanup-operation" {
			data = object(project(value, shape("operationId planId state kind", "s")))
		}
		return queryResult{source: value, data: data, refs: []reference{{kind: args.kind, id: args.id, row: value, filters: args.filters}}}, nil
	}
	projector, kind := fileItem, func(x Object) string { return str(x["kind"]) + "-file" }
	switch args.view {
	case "list":
		value, e = reader.List(ctx, a, args.filters)
	case "summary":
		value, e = reader.Summary(ctx, a, args.filters)
	case "cleanup-candidates":
		value, e = reader.CleanupCandidates(ctx, a, args.filters)
		projector = cleanupCandidateItem
	case "cleanup-plans":
		value, e = reader.CleanupPlans(ctx, a, args.filters)
		projector, kind = cleanupPlanItem, fixedKind("file-cleanup-plan")
	default:
		return queryResult{}, invalid()
	}
	if e != nil {
		return queryResult{}, e
	}
	if args.view == "summary" {
		value, e = queryWireSource(value)
		return queryResult{source: value, data: object(project(value, Object{"scope": "s", "totals": shape("records reservedBytes actualStoredBytes readyFiles pendingScan scanFailed expired revoked removed cleanupPending cleanupResultUnknown cleanupRunning cleanupFailed", "n"), "byKind": []any{merge(Object{"kind": "s"}, shape("records reservedBytes", "n"))}}))}, e
	}
	return typedList(args, value, projector, kind)
}
