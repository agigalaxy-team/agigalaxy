package opportunities

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"sort"
)

var entries = []string{"discover", "publish-task", "participate-task", "ordinary-chat"}

func (s *Service) authorize(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor) error {
	if a == nil {
		return nil
	}
	if s.Devices == nil {
		return fail("discovery_unavailable", 503)
	}
	return s.Devices.AuthorizeWithin(ctx, tx, *a, "history")
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, input Object) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.QueryWithin(ctx, tx, a, input) })
}
func (s *Service) QueryWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	options, e := ParseQuery(input)
	if e != nil {
		return nil, e
	}
	if e = s.authorize(ctx, tx, a); e != nil {
		return nil, e
	}
	context, e := s.ContextWithin(ctx, tx, a, options)
	if e != nil {
		return nil, e
	}
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	windowLimit := s.ScanWindowLimit
	if windowLimit == 0 {
		windowLimit = 200
	}
	if windowLimit < 1 || windowLimit > 200 {
		return nil, fail("invalid_discovery_scan_window", 500)
	}
	var recruitmentLimit, recruitmentPage any
	if s.Recruitment != nil {
		recruitmentLimit, recruitmentPage = 200, "/v2/recruitment/query"
	}
	coverage := Object{"windowLimited": false, "scanWindowLimit": windowLimit, "ordering": "functional-overlap-within-window", "recruitmentPerSubjectLimit": recruitmentLimit, "recruitmentFullPagination": recruitmentPage, "globalCountProvided": false, "globalRanking": false, "currentAuthorizedSources": true}
	result := Object{"schemaVersion": 2, "items": []Object{}, "nextAfter": nil, "enabled": obj(context, "wish")["enabled"], "sourceContext": Object{"kind": obj(options, "context")["kind"], "ref": context["sourceRef"], "persistedContext": false}, "computedAt": s.now(), "method": "functional-tags-v1", "capabilityVerified": false, "activeEntries": entries, "interpretation": "user-side-model-or-user", "coverage": coverage}
	if !truth(obj(context, "wish"), "enabled") {
		result["disabledReason"] = "explicit-discovery-off-or-paused"
		return result, nil
	}
	queryContext := ordered(obj(options, "context"), "kind", "projectId")
	if str(obj(options, "context"), "kind") == "ephemeral" {
		queryContext = ordered(obj(options, "context"), "kind", "title", "functions", "technologies")
	}
	hashValue := ordered(Object{"context": queryContext, "sourceRef": context["sourceRef"], "purposes": options["purposes"], "limit": options["limit"]}, "context", "sourceRef", "purposes", "limit")
	if ref := obj(context, "sourceRef"); ref != nil {
		hashValue.Set("sourceRef", refWire(ref))
	}
	hashBytes, e := protocol.EncodeJS(hashValue)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(hashBytes)
	cursor := Object{"startAfter": nil, "lastKey": nil}
	if after := str(options, "after"); after != "" {
		cursor, e = s.OpenCursor(after, hash, viewer)
		if e != nil {
			return nil, e
		}
	}
	sources := "SELECT subject_id FROM profile_statements"
	if s.Projects != nil {
		sources += " UNION SELECT owner_id AS subject_id FROM projects_v2 WHERE state='active'"
	}
	if s.Recruitment != nil {
		sources += " UNION SELECT contact_subject_id AS subject_id FROM recruitment_opportunities WHERE state='active'"
	}
	rr, e := tx.Query(ctx, "SELECT subject_id FROM (SELECT DISTINCT subject_id FROM ("+sources+") sources WHERE ($1::text IS NULL OR subject_id<>$1) AND ($2::text IS NULL OR subject_id>$2) ORDER BY subject_id)latest ORDER BY subject_id LIMIT $3", nullable(viewer), cursor["startAfter"], windowLimit+1)
	if e != nil {
		return nil, e
	}
	subjects := []string{}
	for rr.Next() {
		var subject string
		if e = rr.Scan(&subject); e != nil {
			rr.Close()
			return nil, e
		}
		subjects = append(subjects, subject)
	}
	e = rr.Err()
	rr.Close()
	if e != nil {
		return nil, e
	}
	window := subjects
	if len(window) > windowLimit {
		window = window[:windowLimit]
	}
	items := []Object{}
	for _, subject := range window {
		more, e := s.opportunityWithin(ctx, tx, a, subject, context)
		if e != nil {
			return nil, e
		}
		items = append(items, more...)
	}
	score := func(x Object) float64 { n, _ := obj(x, "match")["score"].(float64); return n }
	sort.SliceStable(items, func(i, j int) bool {
		if score(items[i]) != score(items[j]) {
			return score(items[i]) > score(items[j])
		}
		return str(items[i], "id") < str(items[j], "id")
	})
	wireItems := []any{}
	for _, item := range items {
		wire, e := s.cardWire(ctx, tx, a, item)
		if e != nil {
			return nil, e
		}
		wireItems = append(wireItems, wire)
	}
	sourceBytes, e := protocol.EncodeJS(wireItems)
	if e != nil {
		return nil, e
	}
	sourceHash := identity.Digest(sourceBytes)
	offset := 0
	if last := str(cursor, "lastKey"); last != "" {
		if cursor["sourceHash"] != sourceHash {
			return nil, fail("discovery_sources_changed_retry", 409)
		}
		found := false
		for i, v := range items {
			if v["id"] == last {
				offset = i + 1
				found = true
				break
			}
		}
		if !found {
			return nil, fail("discovery_cursor_unavailable_restart", 409)
		}
	}
	limit := int(number(options["limit"]))
	end := offset + limit
	if end > len(items) {
		end = len(items)
	}
	page := items[offset:end]
	result["items"] = page
	coverage["windowLimited"] = len(subjects) > windowLimit
	var next any
	if offset+limit < len(items) {
		next, e = s.SealCursor(Object{"v": 2, "queryHash": hash, "viewerId": nullable(viewer), "startAfter": cursor["startAfter"], "lastKey": page[len(page)-1]["id"], "sourceHash": sourceHash})
	} else if len(subjects) > windowLimit {
		next, e = s.SealCursor(Object{"v": 2, "queryHash": hash, "viewerId": nullable(viewer), "startAfter": window[len(window)-1], "lastKey": nil})
	}
	if e != nil {
		return nil, e
	}
	result["nextAfter"] = next
	return result, nil
}
func (s *Service) Detail(ctx context.Context, a *deviceauth.Actor, input Object) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.DetailWithin(ctx, tx, a, input) })
}
func (s *Service) DetailWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	options, e := ParseDetail(input)
	if e != nil {
		return nil, e
	}
	if e = s.authorize(ctx, tx, a); e != nil {
		return nil, e
	}
	context, e := s.ContextWithin(ctx, tx, a, options)
	if e != nil {
		return nil, e
	}
	ref := obj(options, "opportunityRef")
	if !truth(obj(context, "wish"), "enabled") || a != nil && ref["subjectId"] == a.SubjectID {
		return nil, fail("discovery_opportunity_unavailable", 404)
	}
	items, e := s.opportunityWithin(ctx, tx, a, str(ref, "subjectId"), context)
	if e != nil {
		return nil, e
	}
	var opportunity Object
	for _, v := range items {
		if SameRef(obj(v, "opportunityRef"), ref) {
			opportunity = v
			break
		}
	}
	if opportunity == nil {
		return nil, fail("discovery_opportunity_unavailable", 404)
	}
	if s.History == nil {
		return nil, fail("discovery_history_unavailable", 503)
	}
	experience, e := s.History.QueryWithin(ctx, tx, a, encode(Object{"subjectId": ref["subjectId"], "query": "", "after": options["experienceAfter"], "limit": options["experienceLimit"]}))
	if e != nil {
		return nil, e
	}
	values := objectItems(experience["items"])
	refs := []Object{}
	for _, v := range values {
		refs = append(refs, Object{"key": v["key"], "kind": v["kind"], "caseId": v["caseId"], "taskId": v["taskId"]})
	}
	status := "no-visible-page"
	if len(values) > 0 {
		status = "loaded"
	}
	opportunity["experience"] = Object{"status": status, "refs": refs, "absenceMeaning": "only-currently-visible-history; no-capability-or-eligibility-judgment"}
	return Object{"schemaVersion": 2, "opportunity": opportunity, "experience": experience, "experienceRelation": "subject-history; user-must-assess-relevance-to-current-project", "capabilityVerified": false, "activeEntries": entries, "persistedContext": false, "interpretation": "user-side-model-or-user", "computedAt": s.now()}, nil
}
func objectItems(v any) []Object {
	if a, ok := v.([]Object); ok {
		return a
	}
	out := []Object{}
	if a, ok := v.([]any); ok {
		for _, v := range a {
			if x, ok := v.(map[string]any); ok {
				out = append(out, x)
			} else if x, ok := v.(*protocol.OrderedObject); ok && x != nil {
				out = append(out, x.Values())
			}
		}
	}
	return out
}
