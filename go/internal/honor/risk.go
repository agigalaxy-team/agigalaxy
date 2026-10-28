package honor

import (
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

func riskPolicy() *protocol.OrderedObject {
	return ordered("id", "contribution-risk", "version", 4, "bulkWindowSeconds", 60, "bulkMinimumCollaborations", 20, "relationshipScan", "all-current-visible-candidates-in-keyset-pages", "effect", "review-only", "fraudDetermined", false, "automaticPenalty", false)
}
func sortedUnique(values []string) []any {
	seen := map[string]bool{}
	all := []string{}
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			all = append(all, v)
		}
	}
	c := collate.New(language.English)
	sort.SliceStable(all, func(i, j int) bool { return c.CompareString(all[i], all[j]) < 0 })
	out := []any{}
	for _, v := range all {
		out = append(out, v)
	}
	return out
}
func AssessRisk(contributions []Object, complete bool, checkedAt int64, subject string, network *legacySources) *protocol.OrderedObject {
	flags := []any{}
	add := func(code string, items []Object, evidenceIDs []string, details *protocol.OrderedObject) {
		assistanceIDs, caseIDs, eventIDs := []string{}, []string{}, []string{}
		for _, item := range items {
			assistanceIDs = append(assistanceIDs, str(item, "assistanceId"))
			caseIDs = append(caseIDs, str(item, "caseId"))
			for _, v := range array(item["sourceEvents"]) {
				eventIDs = append(eventIDs, str(object(v), "eventId"))
			}
		}
		flag := ordered("code", code, "severity", "review", "assistanceIds", sortedUnique(assistanceIDs), "caseIds", sortedUnique(caseIDs), "eventIds", sortedUnique(eventIDs), "evidenceIds", sortedUnique(evidenceIDs))
		if details != nil {
			for _, key := range details.Keys() {
				flag.Set(key, details.Values()[key])
			}
		}
		flag.Set("fraudDetermined", false)
		flags = append(flags, flag)
	}
	byCase, byEvidence := map[string][]Object{}, map[string][]Object{}
	caseOrder, evidenceOrder := []string{}, []string{}
	type sourceRecord struct{ Item, Proof Object }
	bySource := map[string][]sourceRecord{}
	sourceOrder := []string{}
	for _, item := range contributions {
		caseID := str(item, "caseId")
		if _, ok := byCase[caseID]; !ok {
			caseOrder = append(caseOrder, caseID)
		}
		byCase[caseID] = append(byCase[caseID], item)
		for _, v := range array(item["proofs"]) {
			proof := object(v)
			id := str(proof, "evidenceId")
			if _, ok := byEvidence[id]; !ok {
				evidenceOrder = append(evidenceOrder, id)
			}
			byEvidence[id] = append(byEvidence[id], item)
		}
		observations := item["observations"]
		if observations == nil {
			observations = item["proofs"]
		}
		for _, v := range array(observations) {
			proof := object(v)
			key := str(proof, "sourceKey")
			if key != "" {
				if _, ok := bySource[key]; !ok {
					sourceOrder = append(sourceOrder, key)
				}
				bySource[key] = append(bySource[key], sourceRecord{item, proof})
			}
		}
		if item["independence"] == "issuer-declared-related-party" {
			add("declared-related-parties", []Object{item}, nil, nil)
		}
		acceptedEvent := false
		for _, v := range array(item["sourceEvents"]) {
			if object(v)["kind"] == "accept" {
				acceptedEvent = true
				break
			}
		}
		pending := item["correctionPending"]
		if pending == nil {
			pending = item["corrected"]
		}
		if acceptedEvent && (pending == true || item["disputed"] == true || item["paused"] == true) {
			add("accepted-work-under-review", []Object{item}, nil, nil)
		}
		review := object(item["correctionReview"])
		if review["state"] == "participant-reaccepted" {
			add("corrected-work-reaccepted", []Object{item}, nil, ordered("deliveredCaseReviewVersion", review["deliveredCaseReviewVersion"], "deliveryEventId", review["deliveryEventId"], "acceptanceEventId", review["acceptanceEventId"], "independenceVerified", false))
		}
		unsuccessful := []Object{}
		for _, v := range array(item["observations"]) {
			proof := object(v)
			if proof["conclusion"] != nil && proof["conclusion"] != "success" {
				unsuccessful = append(unsuccessful, proof)
			}
		}
		if item["accepted"] == true && len(unsuccessful) > 0 {
			ids, keys := []string{}, []string{}
			for _, p := range unsuccessful {
				ids = append(ids, str(p, "evidenceId"))
				keys = append(keys, str(p, "sourceKey"))
			}
			add("accepted-work-ci-not-successful", []Object{item}, ids, ordered("sourceKeys", sortedUnique(keys), "taskFailureDetermined", false))
		}
	}
	uniqueCases := func(items []Object, key string) int {
		seen := map[string]bool{}
		for _, item := range items {
			seen[str(item, key)] = true
		}
		return len(seen)
	}
	for _, key := range caseOrder {
		items := byCase[key]
		if uniqueCases(items, "assistanceId") > 1 {
			add("repeated-source-case", items, nil, nil)
		}
	}
	for _, id := range evidenceOrder {
		items := byEvidence[id]
		if uniqueCases(items, "caseId") > 1 {
			add("evidence-reused-across-cases", items, []string{id}, nil)
		}
	}
	for _, key := range sourceOrder {
		records := bySource[key]
		items := []Object{}
		ids := []string{}
		idSet, commits, conclusions := map[string]bool{}, map[string]bool{}, map[string]bool{}
		for _, r := range records {
			items = append(items, r.Item)
			ids = append(ids, str(r.Proof, "evidenceId"))
			idSet[str(r.Proof, "evidenceId")] = true
			commits[str(r.Proof, "commit")] = true
			conclusion := str(r.Proof, "conclusion")
			if r.Proof["conclusion"] == nil {
				conclusion = "<null>"
			}
			conclusions[conclusion] = true
		}
		if uniqueCases(items, "caseId") > 1 || len(idSet) > 1 {
			add("ci-source-reused", items, ids, ordered("sourceKeys", []any{key}))
		}
		if len(commits) > 1 || len(conclusions) > 1 {
			add("ci-source-conflict", items, ids, ordered("sourceKeys", []any{key}))
		}
	}
	if network != nil && subject != "" {
		cycle := reciprocalCycle(network.Contributions, subject)
		if len(cycle) > 0 {
			subjects := []string{}
			edges := []any{}
			for _, item := range cycle {
				subjects = append(subjects, str(item, "requesterId"), str(item, "subjectId"))
				ids := []any{}
				for _, v := range array(item["sourceEvents"]) {
					event := object(v)
					if event["kind"] == "accept" {
						ids = append(ids, event["eventId"])
					}
				}
				edges = append(edges, ordered("requesterId", item["requesterId"], "providerId", item["subjectId"], "assistanceId", item["assistanceId"], "caseId", item["caseId"], "acceptanceEventIds", ids))
			}
			add("reciprocal-acceptance-cycle", cycle, nil, ordered("subjectIds", sortedUnique(subjects), "edges", edges, "independenceVerified", false, "relationshipInferred", false))
		}
	}
	timeline := []Object{}
	indices := map[string]int{}
	for _, item := range contributions {
		if !integer(item["participatedAt"], -9007199254740991, 9007199254740991) {
			continue
		}
		id := str(item, "assistanceId")
		if i, ok := indices[id]; ok {
			timeline[i] = item
		} else {
			indices[id] = len(timeline)
			timeline = append(timeline, item)
		}
	}
	c := collate.New(language.English)
	sort.SliceStable(timeline, func(i, j int) bool {
		if a, b := number(timeline[i]["participatedAt"]), number(timeline[j]["participatedAt"]); a != b {
			return a < b
		}
		return c.CompareString(str(timeline[i], "assistanceId"), str(timeline[j], "assistanceId")) < 0
	})
	for start := 0; start < len(timeline); {
		end := start + 1
		for end < len(timeline) && number(timeline[end]["participatedAt"])-number(timeline[start]["participatedAt"]) < 60 {
			end++
		}
		if end-start >= 20 {
			add("concentrated-participation", timeline[start:end], nil, nil)
			start = end
		} else {
			start++
		}
	}
	fully := complete
	var relationship any
	if network != nil {
		fully = fully && network.Complete
		relationship = network.Complete
	}
	status := "no-signals-in-visible-sources"
	if !fully {
		status = "incomplete-source-scan"
	} else if len(flags) > 0 {
		status = "review-suggested"
	}
	return ordered("policy", riskPolicy(), "checkedAt", checkedAt, "complete", fully, "contributionScanComplete", complete, "relationshipScanComplete", relationship, "coverage", "currently visible contributions in this capability, community and time window", "status", status, "flags", flags, "automaticPenalty", false, "fraudDetermined", false, "limitations", []any{"No hidden-source scan", "Related parties are issuer-declared, not independently verified", "Visible acceptance cycles do not establish collusion or independent verification", "CI observations remain repository-controlled; no independent human verifier is inferred", "Bulk participation can be legitimate", "Missing CI is not a false-success finding", "No global trust or fraud score"})
}
func reciprocalCycle(contributions []Object, subject string) []Object {
	edges := []Object{}
	indices := map[string]int{}
	for _, item := range contributions {
		if item["eligible"] != true || item["accepted"] != true || item["requesterId"] == item["subjectId"] {
			continue
		}
		accepted := false
		for _, v := range array(item["sourceEvents"]) {
			event := object(v)
			if event["kind"] == "accept" && event["actorId"] == item["requesterId"] {
				accepted = true
				break
			}
		}
		if !accepted {
			continue
		}
		id := str(item, "assistanceId")
		if i, ok := indices[id]; ok {
			edges[i] = item
		} else {
			indices[id] = len(edges)
			edges = append(edges, item)
		}
	}
	reachable := func(reverse bool) map[string]bool {
		graph := map[string][]string{}
		for _, edge := range edges {
			from, to := str(edge, "requesterId"), str(edge, "subjectId")
			if reverse {
				from, to = to, from
			}
			graph[from] = append(graph[from], to)
		}
		found := map[string]bool{subject: true}
		queue := []string{subject}
		for i := 0; i < len(queue); i++ {
			for _, next := range graph[queue[i]] {
				if !found[next] {
					found[next] = true
					queue = append(queue, next)
				}
			}
		}
		return found
	}
	forward, reverse := reachable(false), reachable(true)
	component := map[string]bool{}
	for id := range forward {
		if reverse[id] {
			component[id] = true
		}
	}
	out := []Object{}
	if len(component) < 2 {
		return out
	}
	for _, edge := range edges {
		if component[str(edge, "requesterId")] && component[str(edge, "subjectId")] {
			out = append(out, edge)
		}
	}
	return out
}
