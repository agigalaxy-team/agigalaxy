// Package information composes the existing permitted source projections and
// selected private watch receipts. No query runs a model or publishes content.
package information

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"time"
)

type SourceReader func(context.Context, *deviceauth.Actor, []byte) (Object, error)
type Service struct {
	Endpoint string
	Search   *searchv2.Service
	Honor    SourceReader
	Now      func() time.Time
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}

var HelpPaths = []any{"continue-current-ai", "capsule-or-history", "open-assistance", "bounty-or-expert-assistance"}
var limitations = []any{"Only the current viewer’s permitted sources are queried; no global count or expert ranking.", "Missing history, unavailable sources and unexpressed willingness are not lack of ability.", "Original event, environment, configuration, failure and verification meanings remain in each record.", "The user or their Agent interprets and chooses; querying never publishes, contacts or runs a model."}

func viewer(a *deviceauth.Actor) any {
	if a == nil {
		return nil
	}
	return a.SubjectID
}
func (s *Service) QueryID(a *deviceauth.Actor, purpose string, sources []any) (string, error) {
	selected := []any{}
	for _, v := range sources {
		o := obj(v)
		selected = append(selected, Object{"key": o["key"], "source": Base(obj(o["source"]))})
	}
	return Digest(Object{"version": 2, "endpoint": s.Endpoint, "viewer": viewer(a), "purpose": purpose, "sources": selected})
}
func coalesce(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
func copyObject(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func (s *Service) Source(ctx context.Context, a *deviceauth.Actor, selection Object) (Object, error) {
	src := obj(selection["source"])
	kind := text(src, "kind")
	view := "source-query"
	if kind == "honor" {
		view = "scoped-honor"
	} else if kind == "reference" {
		view = "current-object"
	}
	method := Object{"id": "galaxy-permitted-information", "version": "2.0.0", "view": view}
	base := Object{"key": selection["key"], "scope": Scope(src), "source": Base(src), "method": method, "checkedAt": s.now(), "observedAt": s.now(), "observedAtMeaning": "time this authorized projection was observed; original source dates are not refreshed", "cacheable": false}
	var page Object
	var e error
	switch kind {
	case "honor":
		if s.Honor == nil {
			e = fault.New("honor_source_unavailable", 503)
		} else {
			page, e = s.Honor(ctx, a, encode(src["request"]))
		}
	case "search":
		if s.Search == nil {
			e = fault.New("search_source_unavailable", 503)
		} else {
			page, e = s.Search.Query(ctx, a, encode(src["request"]))
		}
	case "reference":
		if s.Search == nil {
			e = fault.New("search_source_unavailable", 503)
		} else {
			page, e = s.Search.Reference(ctx, a, encode(src["request"]))
		}
	default:
		e = fault.New("invalid_information_query", 400)
	}
	var items []any
	var next any
	if e == nil {
		switch kind {
		case "honor":
			card := obj(page["card"])
			rule := obj(card["rule"])
			title := coalesce(rule["title"], rule["id"])
			items = []any{Object{"id": card["id"], "sourceVersion": page["sourceFingerprint"], "ref": Object{"id": card["id"], "version": page["sourceFingerprint"]}, "title": title, "record": page["card"], "authority": "versioned-scoped-rule-over-current-authorized-contributions", "recordKind": "honor-view", "source": card["rule"], "supportingItems": page["items"], "limitations": []any{"A scoped Honor is not a global score, a source-text grant or paid qualification."}, "sourceStatus": card["status"]}}
			next = page["nextAfter"]
		case "reference":
			items = []any{}
			if page["item"] != nil {
				items = append(items, page["item"])
			}
		default:
			var ok bool
			switch values := page["items"].(type) {
			case []any:
				items, ok = values, true
			case []Object:
				items, ok = list(values), true
			}
			if !ok {
				e = fault.New("information_source_response_invalid", 503)
			}
			next = page["nextCursor"]
		}
	}
	if e != nil {
		var f *fault.Error
		if errors.As(e, &f) && f.Status == 400 {
			return nil, e
		}
		hidden := errors.As(e, &f) && (f.Status == 401 || f.Status == 403 || f.Status == 404)
		state, reason := "temporarily-unavailable", "This source could not be read; other sources remain independent."
		actions := []any{"retry-source", "choose-help-path"}
		if hidden {
			state, reason = "no-visible-data", "No permitted result is available."
			actions = []any{"refine-scope", "choose-help-path"}
		}
		out := copyObject(base)
		out["state"] = state
		out["items"] = []any{}
		out["sourceVersions"] = []any{}
		out["nextCursor"] = nil
		out["complete"] = false
		out["coverage"] = Object{"scope": "no-extra-source-existence-disclosed"}
		out["countsScope"] = "current-authorized-page-only"
		out["limitations"] = append(append([]any{}, limitations...), reason)
		out["nextActions"] = actions
		return out, nil
	}
	state := "no-visible-data"
	if len(items) > 0 {
		state = "available"
	}
	versions := []any{}
	for _, v := range items {
		o := obj(v)
		versions = append(versions, Object{"id": o["id"], "version": o["sourceVersion"]})
	}
	out := copyObject(base)
	out["state"], out["items"], out["sourceVersions"], out["nextCursor"] = state, items, versions, next
	out["coverage"] = coalesce(page["coverage"], page["coverageDescription"], Object{"scope": coalesce(page["coverage"], "selected-source")})
	out["countsScope"] = "current-authorized-page-only"
	out["complete"] = next == nil || next == ""
	out["sourceState"] = coalesce(page["sourceState"], page["state"], obj(page["card"])["status"])
	out["limitations"] = append(append([]any{}, limitations...), list(page["limitations"])...)
	out["nextActions"] = []any{"read-source", "refine-scope", "choose-help-path"}
	if kind == "honor" {
		method := copyObject(method)
		method["rule"] = obj(page["card"])["rule"]
		out["method"] = method
		out["sourceFingerprint"] = page["sourceFingerprint"]
	}
	return out, nil
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := ParseQuery(raw)
	if e != nil {
		return nil, e
	}
	sources := list(input["sources"])
	id, e := s.QueryID(a, text(input, "purpose"), sources)
	if e != nil {
		return nil, e
	}
	if expected := text(input, "queryId"); expected != "" && expected != id {
		return nil, fault.New("information_query_scope_changed", 409)
	}
	items, scope := []any{}, []any{}
	cursors := Object{}
	partial := false
	for _, selection := range sources {
		selected := obj(selection)
		value, e := s.Source(ctx, a, selected)
		if e != nil {
			return nil, e
		}
		items = append(items, value)
		cursors[text(value, "key")] = value["nextCursor"]
		partial = partial || value["state"] == "temporarily-unavailable"
		scope = append(scope, Object{"key": selected["key"], "source": Base(obj(selected["source"])), "requiredScope": Scope(obj(selected["source"]))})
	}
	return Object{"schemaVersion": 2, "queryId": id, "purpose": input["purpose"], "scope": scope, "method": Object{"id": "independent-authorized-source-projections", "version": "2.0.0", "ranking": false}, "observedAt": s.now(), "observedAtMeaning": "query observation, not evidence occurrence or external observation date", "items": items, "cursors": cursors, "partial": partial, "helpPaths": HelpPaths, "nextActions": []any{"continue-current-ai", "read-capsule-or-history", "publish-open-assistance", "consider-bounty-or-expert", "discover-or-chat"}, "cacheable": false, "modelCalls": 0, "interpretation": "user-or-user-agent", "limitations": limitations}, nil
}
