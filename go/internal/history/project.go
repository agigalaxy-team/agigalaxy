package history

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

func projectCase(parent Object, events []Object, owner bool, proofs []any) (*ordered, error) {
	var root Object
	for _, row := range events {
		p := obj(row["payload"])
		if p["kind"] == "case" {
			root = p
			break
		}
	}
	if root == nil {
		return nil, fault.New("history_source_inconsistent", 503)
	}
	corrections, attempts, results, reviews := []any{}, []any{}, []any{}, []any{}
	corrected := map[string]bool{}
	for _, row := range events {
		p := obj(row["payload"])
		if p["kind"] == "revision" && p["review"] == nil {
			c := newObject()
			for _, k := range []string{"id", "correctsEventId", "reason", "summary"} {
				copyField(c, k, p, k)
			}
			corrections = append(corrections, c)
			corrected[str(p, "correctsEventId")] = true
		}
	}
	threads := map[string]*ordered{}
	for _, row := range events {
		p := obj(row["payload"])
		switch p["kind"] {
		case "attempt":
			a := newObject()
			copyField(a, "id", p, "id")
			copyField(a, "sequence", p, "sequence")
			if owner {
				copyField(a, "approach", p, "approach")
				copyField(a, "configuration", p, "configuration")
			}
			attempts = append(attempts, a)
		case "result":
			r := newObject()
			for _, k := range []string{"id", "attemptId", "outcome", "summary", "failureReason", "limitations"} {
				copyField(r, k, p, k)
			}
			r.Set("corrected", corrected[str(p, "id")])
			results = append(results, r)
		case "revision":
			review := obj(p["review"])
			if review == nil {
				continue
			}
			id := str(review, "threadId")
			thread := threads[id]
			if thread == nil {
				thread = newObject()
				thread.Set("threadId", review["threadId"])
				thread.Set("type", review["type"])
				thread.Set("targetEventId", p["correctsEventId"])
				thread.Set("authority", "case-owner-reported")
				thread.Set("independentDecision", false)
				thread.Set("changes", []any{})
				threads[id] = thread
				reviews = append(reviews, thread)
			}
			thread.Set("state", review["state"])
			change := newObject()
			change.Set("eventId", p["id"])
			change.Set("state", review["state"])
			copyField(change, "reason", p, "reason")
			copyField(change, "summary", p, "summary")
			thread.Set("changes", append(array(thread.Values()["changes"]), change))
		}
	}
	item := newObject()
	item.Set("caseId", parent["id"])
	item.Set("sourceVersion", parent["version"])
	copyField(item, "title", root, "title")
	copyField(item, "summary", root, "summary")
	item.Set("state", parent["state"])
	item.Set("attempts", attempts)
	item.Set("results", results)
	item.Set("corrections", corrections)
	item.Set("reviews", reviews)
	item.Set("proofs", proofs)
	item.Set("capabilityVerified", false)
	item.Set("verification", "reported-results; proofs retain their own limited scope")
	if owner {
		copyField(item, "participants", root, "participants")
		copyField(item, "source", root, "source")
		if t, e := time.Parse(time.RFC3339Nano, str(parent, "created_at")); e == nil {
			item.Set("registeredAt", t.UTC().Format("2006-01-02T15:04:05.000Z"))
		} else {
			return nil, e
		}
	}
	raw, e := protocol.EncodeJS(item)
	if e != nil {
		return nil, e
	}
	item.Set("projectionHash", identity.Digest(raw))
	return item, nil
}
func fieldPolicy(item *ordered, view string) *ordered {
	allowed := []string{"caseId", "sourceVersion", "title", "summary", "state", "attempts", "results", "corrections", "reviews", "proofs", "capabilityVerified", "verification", "projectionHash", "capsuleReuse", "collaborationContext", "reportedProgress", "fieldPolicy", "moderationContext"}
	if view == "owner" {
		allowed = append(allowed, "participants", "source", "registeredAt")
	}
	out := pick(item, allowed...)
	attempts := []any{}
	for _, v := range array(item.Values()["attempts"]) {
		fields := []string{"id", "sequence"}
		if view == "owner" {
			fields = append(fields, "approach", "configuration")
		}
		a := pick(v, fields...)
		if c, ok := a.Values()["configuration"]; ok {
			a.Set("configuration", pick(c, "environment", "version", "tools"))
		}
		attempts = append(attempts, a)
	}
	out.Set("attempts", attempts)
	results := []any{}
	for _, v := range array(item.Values()["results"]) {
		results = append(results, pick(v, "id", "attemptId", "outcome", "summary", "failureReason", "limitations", "corrected"))
	}
	out.Set("results", results)
	corrections := []any{}
	for _, v := range array(item.Values()["corrections"]) {
		corrections = append(corrections, pick(v, "id", "correctsEventId", "reason", "summary"))
	}
	out.Set("corrections", corrections)
	reviews := []any{}
	for _, v := range array(item.Values()["reviews"]) {
		r := pick(v, "threadId", "type", "targetEventId", "authority", "independentDecision", "state")
		changes := []any{}
		for _, change := range array(obj(v)["changes"]) {
			changes = append(changes, pick(change, "eventId", "state", "reason", "summary"))
		}
		r.Set("changes", changes)
		reviews = append(reviews, r)
	}
	out.Set("reviews", reviews)
	if v, ok := out.Values()["source"]; ok {
		out.Set("source", pick(v, "kind", "reference"))
	}
	if v, ok := out.Values()["participants"]; ok {
		persons := []any{}
		for _, person := range array(v) {
			persons = append(persons, pick(person, "subjectId", "role"))
		}
		out.Set("participants", persons)
	}
	out.Set("fieldPolicy", Object{"id": "history-fields", "version": 1, "view": view})
	return out
}
func progress(events []Object) Object {
	corrected := map[string]bool{}
	for _, row := range events {
		p := obj(row["payload"])
		if p["kind"] == "revision" && p["review"] == nil {
			corrected[str(p, "correctsEventId")] = true
		}
	}
	timeline, subsequent := []any{}, []any{}
	var success Object
	var last any
	for _, row := range events {
		p := obj(row["payload"])
		if p["kind"] != "result" {
			continue
		}
		r := Object{"resultId": p["id"], "attemptId": p["attemptId"], "outcome": p["outcome"], "sourceEventVersion": row["version"], "corrected": corrected[str(p, "id")]}
		timeline = append(timeline, r)
		last = p["id"]
		if success != nil && p["outcome"] != "succeeded" {
			relation := "different-attempt"
			if p["attemptId"] == success["attemptId"] {
				relation = "same-attempt"
			}
			subsequent = append(subsequent, Object{"previousSuccessId": success["resultId"], "resultId": p["id"], "attemptRelation": relation, "regressionVerified": false})
		}
		if p["outcome"] == "succeeded" {
			success = r
		}
	}
	return Object{"version": 1, "authority": "case-owner-reported", "latestResultId": last, "timeline": timeline, "subsequentReports": subsequent, "capabilityVerified": false, "attemptCountIsCapability": false}
}
func rebuild(item *ordered, events []Object, endpoint, view string) (Object, error) {
	if int64(len(events)) != num(item.Values(), "sourceVersion") || len(events) == 0 || events[0]["kind"] != "case" || events[0]["id"] != item.Values()["caseId"] {
		return nil, fault.New("history_source_inconsistent", 503)
	}
	sources := []any{}
	for i, r := range events {
		if num(r, "version") != int64(i+1) {
			return nil, fault.New("history_source_inconsistent", 503)
		}
		sources = append(sources, Object{"id": r["id"], "kind": r["kind"], "version": r["version"]})
	}
	version := 3
	if item.Values()["moderationContext"] != nil {
		version = 4
	}
	fields := []string{"caseId", "sourceVersion", "title", "summary", "state", "attempts", "results", "corrections", "reviews", "proofs", "capabilityVerified", "verification", "participants", "source", "registeredAt", "capsuleReuse", "collaborationContext", "reportedProgress", "fieldPolicy"}
	if version == 4 {
		fields = append(fields, "moderationContext")
	}
	hash, e := contentHash(pick(item, fields...))
	if e != nil {
		return nil, e
	}
	ids := func(values []any, key string) []any {
		out := []any{}
		for _, v := range values {
			out = append(out, obj(v)[key])
		}
		return out
	}
	return Object{"rule": Object{"id": "case-history", "version": version}, "endpoint": endpoint, "caseId": item.Values()["caseId"], "sourceVersion": item.Values()["sourceVersion"], "view": view, "contentHash": hash, "sources": Object{"events": sources, "proofIds": ids(array(item.Values()["proofs"]), "proofId"), "capsuleUseIds": ids(array(obj(item.Values()["capsuleReuse"])["items"]), "id"), "assistanceIds": ids(array(obj(item.Values()["collaborationContext"])["items"]), "assistanceId")}}, nil
}
func explanation(item *ordered, o options, now int64) Object {
	links := []any{}
	for _, link := range array(obj(item.Values()["collaborationContext"])["items"]) {
		if o.Capability == nil || obj(link)["capabilityId"] == *o.Capability {
			links = append(links, link)
		}
	}
	if o.Capability != nil && len(links) == 0 {
		return nil
	}
	proofs := array(item.Values()["proofs"])
	strength := "reported-only"
	if len(proofs) > 0 {
		strength = "ci-execution-fact"
	}
	if o.Strength != nil && *o.Strength != strength {
		return nil
	}
	textMatches := []any{}
	for _, term := range o.Terms {
		fields := []string{}
		for _, k := range []string{"title", "summary"} {
			if strings.Contains(lower(str(item.Values(), k)), term) {
				fields = append(fields, k)
			}
		}
		textMatches = append(textMatches, Object{"term": term, "fields": fields})
	}
	capability := []any{}
	if o.Capability != nil {
		for _, link := range links {
			v := obj(link)
			capability = append(capability, Object{"capabilityId": v["capabilityId"], "assistanceId": v["assistanceId"], "authority": "requester-declared-requirement"})
		}
	}
	proofIDs := []any{}
	sources := []any{Object{"kind": "case", "id": item.Values()["caseId"]}, Object{"kind": "history", "id": item.Values()["caseId"]}}
	for _, p := range proofs {
		id := obj(p)["proofId"]
		proofIDs = append(proofIDs, id)
		sources = append(sources, Object{"kind": "proof", "id": id})
	}
	meaning := "No current visible CI Proof in this bounded projection; not a claim that no other evidence exists."
	if len(proofs) > 0 {
		meaning = "At least one current visible limited CI execution Proof."
	}
	out := Object{"rule": Object{"id": "visible-history-rules", "version": 1}, "sourceType": "case-history", "caseId": item.Values()["caseId"], "order": "case-id", "scope": "current-authorized-view", "checkedAt": now, "textMatches": textMatches, "capabilityMatches": capability, "verification": Object{"strength": strength, "proofIds": proofIDs, "capabilityVerified": false, "meaning": meaning}, "sources": sources, "limitations": []string{"Text terms match the disclosed Case title and summary.", "Capability associations describe requested work, not verified proficiency.", "UUID ordering is stable pagination, not a ranking of experts.", "CI observations do not independently verify task outcome or individual capability."}}
	if v, ok := item.Values()["registeredAt"]; ok {
		out["registeredAt"] = v
	}
	return out
}
