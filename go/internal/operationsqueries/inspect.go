package operationsqueries

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

// InspectOperations is a fixed, bounded composition of the existing authorized
// readers. It never makes the samples stand in for complete populations.
func (s *Service) InspectOperations(ctx context.Context, actor Actor, domain string) (Object, error) {
	current, err := s.human(ctx, actor, domain, "workbench.read")
	if err != nil {
		return nil, err
	}
	type result struct {
		key      string
		value    Object
		deadline int64
	}
	results := make(chan result, 7)
	var wg sync.WaitGroup
	add := func(key string, fn func() (Object, int64)) {
		wg.Add(1)
		go func() { defer wg.Done(); value, deadline := fn(); results <- result{key, value, deadline} }()
	}
	failure := func(err error) Object {
		state := "unavailable"
		if fault.Status(err) == 403 {
			state = "not-authorized"
		}
		return Object{"availability": state, "collectionComplete": false}
	}
	add("workbench", func() (Object, int64) {
		if s.Workbench == nil {
			return failure(nil), 0
		}
		wb := *s.Workbench
		wb.AutonomySummary = nil // Duty's actual owner supplies the separate segment.
		source, e := wb.SummaryWithAuthority(ctx, current, Object{"publicActivity": "deferred"}, s.reader(current))
		if e != nil {
			return failure(e), 0
		}
		data := ConversationSummary(source, domain, current.Permissions)
		delete(object(data["availability"]), "autonomy")
		delete(data, "autonomy")
		ok := true
		excluded := []any{}
		for key, state := range object(data["availability"]) {
			if state == "not-authorized" {
				excluded = append(excluded, key)
				continue
			}
			if state != "available" {
				ok = false
			}
		}
		status := "available"
		if !ok {
			status = "partial"
		}
		deadline, _ := number(data["readExpiresAt"])
		return Object{"availability": status, "basis": "current-permitted-workbench-snapshot", "scope": "domain-permitted-counts-and-latest-12-changes", "coverage": "permission-filtered-public-activity-deferred", "excludedNotAuthorized": excluded, "collectionComplete": ok, "data": data}, int64(deadline)
	})
	query := func(module string, filters Object) (Object, int64, error) {
		out, e := s.Query(ctx, current, domain, "query-operations", Object{"module": module, "view": "overview", "filters": filters})
		if e != nil {
			return nil, 0, e
		}
		if out["availability"] != "available" {
			return nil, 0, fail("operations_query_not_configured", 503)
		}
		deadline, _ := number(out["readExpiresAt"])
		return out, int64(deadline), nil
	}
	add("maintenance", func() (Object, int64) {
		out, d, e := query("maintenance", Object{})
		if e != nil {
			return failure(e), 0
		}
		data := object(out["data"])
		queues := object(data["queues"])
		components := object(data["componentSummary"])
		ok := object(queues["availability"])["state"] == "available" && queues["includesAllPlatformQueues"] == true && components["complete"] == true
		state := "available"
		if !ok {
			state = "partial"
		}
		return Object{"availability": state, "basis": "maintenance-overview", "scope": "queue-counts-and-components", "coverage": "current-source", "collectionComplete": ok, "data": data}, d
	})
	add("search", func() (Object, int64) {
		out, d, e := query("search", Object{"days": 7, "limit": 20})
		if e != nil {
			return failure(e), 0
		}
		data := object(out["data"])
		pages := object(out["pagination"])
		ok := inspectSearchComplete(data)
		state := "available"
		if !ok {
			state = "partial"
		}
		return Object{"availability": state, "basis": data["basis"], "scope": "search-overview", "window": data["period"], "coverage": "metrics-and-configuration-with-bounded-query-sample", "collectionComplete": ok, "querySample": Object{"collectionComplete": pages["complete"], "limit": 20, "nextAvailable": pages["next"] != nil}, "data": data}, d
	})
	add("recommendations", func() (Object, int64) {
		out, d, e := query("recommendations", Object{"days": 30})
		if e != nil {
			return failure(e), 0
		}
		data := object(out["data"])
		complete := inspectRecommendationsComplete(data)
		state := "available"
		if !complete {
			state = "partial"
		}
		return Object{"availability": state, "basis": data["basis"], "scope": "recommendations-overview", "window": data["period"], "coverage": "native-metrics-and-bounded-public-supply", "profileComplete": complete, "supplySample": Object{"scope": object(data["basis"])["supplyScope"], "collectionComplete": object(data["basis"])["sourceScanComplete"]}, "data": data}, d
	})
	add("analytics", func() (Object, int64) {
		out, d, e := query("analytics", Object{"days": 7})
		if e != nil {
			return failure(e), 0
		}
		data := object(out["data"])
		ok := data["data"] != nil && data["coverage"] != nil
		state := "available"
		if !ok {
			state = "partial"
		}
		return Object{"availability": state, "basis": data["basis"], "scope": "analytics-overview", "window": "last-7-days", "coverage": data["coverage"], "collectionComplete": ok, "data": data}, d
	})
	add("messaging", func() (Object, int64) {
		input := Object{"module": "messaging", "view": "plans", "filters": Object{"limit": 50}}
		items := []any{}
		var summary any
		var deadline int64
		complete := false
		for page := 0; page < 2; page++ {
			out, e := s.Query(ctx, current, domain, "query-operations", input)
			if e != nil {
				return failure(e), 0
			}
			if out["availability"] != "available" {
				return failure(nil), 0
			}
			d, _ := number(out["readExpiresAt"])
			if deadline == 0 || int64(d) < deadline {
				deadline = int64(d)
			}
			data := object(out["data"])
			if page == 0 {
				summary = data["summary"]
			}
			for _, v := range anyArray(data["items"]) {
				r := object(v)
				items = append(items, Object{"id": r["id"], "state": r["state"], "effectiveState": r["effectiveState"], "version": r["version"], "revision": r["revision"]})
			}
			paging := object(out["pagination"])
			if paging["complete"] == true {
				complete = true
				break
			}
			next := object(paging["next"])
			if next == nil {
				break
			}
			input = next
		}
		state := "available"
		if !complete || summary == nil {
			state = "partial"
		}
		return Object{"availability": state, "basis": "messaging-current-plans", "scope": "current-plans", "coverage": "up-to-two-pages-of-50", "collectionComplete": complete, "data": Object{"summary": summary, "plans": items}}, deadline
	})
	add("autonomy", func() (Object, int64) {
		if s.DutyCurrentInspection == nil {
			return failure(nil), 0
		}
		value, e := s.DutyCurrentInspection(ctx, current, domain)
		if e != nil {
			return failure(e), 0
		}
		if value == nil {
			return failure(nil), 0
		}
		d, _ := number(value["readExpiresAt"])
		return value, int64(d)
	})
	// Delegation reads retain their source audit and target-specific authority.
	// Kept in this goroutine to bound prompt-read concurrency and total size.
	var delegation Object
	var delegationDeadline int64
	wg.Add(1)
	go func() { defer wg.Done(); delegation, delegationDeadline = s.inspectDelegation(ctx, current, domain) }()
	wg.Wait()
	close(results)
	segments := Object{"delegation": delegation}
	deadline := s.now() + 30
	if delegationDeadline > 0 && delegationDeadline < deadline {
		deadline = delegationDeadline
	}
	for r := range results {
		segments[r.key] = r.value
		if r.deadline > 0 && r.deadline < deadline {
			deadline = r.deadline
		}
	}
	fresh, e := s.human(ctx, current, domain, "workbench.read")
	if e != nil {
		return nil, e
	}
	if fresh.Version != current.Version {
		return nil, fail("operations_agentos_authority_changed", 403)
	}
	if deadline <= s.now() {
		return nil, fail("operations_query_expired", 410)
	}
	checked := inspectionComplete(segments)
	status := "available"
	if !checked {
		status = "partial"
	}
	out := Object{"tool": "inspect-operations", "profile": "current-operations-v1", "availability": status, "inspectionChecked": checked, "profileComplete": checked, "segments": segments, "checkedAt": s.now(), "readExpiresAt": deadline, "evidenceRefs": []any{}}
	raw, e := json.Marshal(out)
	if e != nil || len(raw) > 180000 {
		return nil, fail("operations_query_response_too_large", 503)
	}
	return out, nil
}

func (s *Service) inspectDelegation(ctx context.Context, actor Actor, domain string) (Object, int64) {
	failure := func(state string) Object {
		return Object{"availability": state, "basis": "current-delegation-targets", "scope": "delegated-target-prompts", "collectionComplete": false}
	}
	if s.Permissions == nil {
		return failure("unavailable"), 0
	}
	directory, e := s.Permissions.DelegatedDirectory(ctx, actor)
	if e != nil {
		if fault.Status(e) == 403 {
			return failure("not-authorized"), 0
		}
		return failure("unavailable"), 0
	}
	deadlineN, _ := number(directory["readExpiresAt"])
	deadline := int64(deadlineN)
	canRead := object(directory["availability"])["canReadPrompts"] == true
	rows := []any{}
	complete := canRead
	used := 0
	seen := map[string]bool{}
	for _, v := range anyArray(directory["targetAiAccounts"]) {
		target := object(v)
		id := str(target["id"])
		entry := Object{"id": id, "domain": target["domain"], "enabled": target["enabled"], "textComplete": false}
		if !validID(id) || seen[id] {
			complete = false
			rows = append(rows, entry)
			continue
		}
		seen[id] = true
		if !canRead {
			complete = false
			rows = append(rows, entry)
			continue
		}
		prompt, e := s.Permissions.DelegatedPrompt(ctx, actor, Object{"aiAccountId": id})
		if e != nil {
			complete = false
			rows = append(rows, entry)
			continue
		}
		d, _ := number(prompt["readExpiresAt"])
		if d > 0 && (deadline == 0 || int64(d) < deadline) {
			deadline = int64(d)
		}
		p := object(prompt["prompt"])
		for _, key := range []string{"configId", "revision", "promptVersion", "updatedAt"} {
			entry[key] = p[key]
		}
		body, ok := p["text"].(string)
		if ok && used+len(body) <= 60000 {
			entry["text"] = body
			entry["textComplete"] = true
			used += len(body)
		} else {
			complete = false
			entry["readRef"] = Object{"tool": "read-ai-delegation", "arguments": Object{"aiAccountId": id}}
		}
		rows = append(rows, entry)
	}
	state := "available"
	if !complete {
		state = "partial"
	}
	return Object{"availability": state, "basis": "current-delegation-targets", "scope": "delegated-target-prompts", "coverage": "current-authorized-targets", "collectionComplete": complete, "contentTrust": "configuration-data", "instructionAuthority": "none", "targetCount": len(rows), "targets": rows}, deadline
}

// inspectionComplete describes the fixed promised aggregates, not whether every
// intentionally bounded search sample has exhausted its underlying population.
func inspectionComplete(segments Object) bool {
	for _, key := range []string{"workbench", "maintenance", "search", "recommendations", "analytics", "messaging", "autonomy", "delegation"} {
		v := object(segments[key])
		if v["availability"] != "available" {
			return false
		}
		if key == "recommendations" {
			if v["profileComplete"] != true {
				return false
			}
			continue
		}
		if v["collectionComplete"] != true {
			return false
		}
	}
	return true
}

func inspectSearchComplete(data Object) bool {
	return object(data["metrics"])["searches"] != nil && object(object(data["configuration"])["native"])["state"] == "available" && data["activeSettings"] != nil && data["draftSettingsUnavailable"] != true
}
func inspectRecommendationsComplete(data Object) bool {
	return data["directionsComplete"] == true && object(data["metrics"])["exposures"] != nil
}
