package honor

import "sort"

var sourceFields = []string{"sourceEvents", "proofs", "observations", "revisionIds"}
var riskFields = []string{"assistanceIds", "caseIds", "eventIds", "evidenceIds", "sourceKeys", "subjectIds", "edges"}

func copyObject(value any) Object {
	out := Object{}
	for k, v := range object(value) {
		out[k] = v
	}
	return out
}
func boundedEdge(value any) Object {
	o := copyObject(value)
	a := array(o["acceptanceEventIds"])
	o["acceptanceEventIds"] = a[:min(len(a), 20)]
	o["acceptanceEventCount"] = len(a)
	return o
}
func bounded(value any, fields []string) Object {
	o := copyObject(value)
	counts := Object{}
	complete := true
	for _, k := range fields {
		v, ok := o[k]
		if !ok {
			continue
		}
		a := array(v)
		if a == nil {
			continue
		}
		counts[k] = len(a)
		page := append([]any{}, a[:min(len(a), 20)]...)
		if len(a) > 20 {
			complete = false
		}
		if k == "edges" {
			for i, v := range page {
				if len(array(object(v)["acceptanceEventIds"])) > 20 {
					complete = false
				}
				page[i] = boundedEdge(v)
			}
		}
		o[k] = page
	}
	o["referenceCounts"] = counts
	o["referencesComplete"] = complete
	return o
}
func referencePage(value any, fields []string, after, limit int) Object {
	items := []any{}
	for _, kind := range fields {
		for _, v := range array(object(value)[kind]) {
			if kind == "edges" {
				items = append(items, Object{"kind": kind, "value": boundedEdge(v)})
				for _, id := range array(object(v)["acceptanceEventIds"]) {
					items = append(items, Object{"kind": "edgeAcceptanceEvents", "value": Object{"assistanceId": object(v)["assistanceId"], "eventId": id}})
				}
			} else {
				items = append(items, Object{"kind": kind, "value": v})
			}
		}
	}
	var next any
	if after+limit < len(items) {
		next = after + limit
	}
	start := min(after, len(items))
	return Object{"after": after, "nextAfter": next, "total": len(items), "items": items[start:min(len(items), start+limit)]}
}
func idPage(items []any, key, after string, limit int) ([]any, Object) {
	a := append([]any{}, items...)
	sort.SliceStable(a, func(i, j int) bool { return str(object(a[i]), key) < str(object(a[j]), key) })
	selected := []any{}
	for _, v := range a {
		if after == "" || str(object(v), key) > after {
			selected = append(selected, v)
		}
	}
	page := selected[:min(len(selected), limit)]
	var next, previous any
	if after != "" {
		previous = after
	}
	if len(selected) > limit {
		next = object(page[len(page)-1])[key]
	}
	return page, Object{"after": previous, "nextAfter": next, "total": len(items)}
}
func paginate(view, q Object) (Object, error) {
	card := object(view["card"])
	if q["expectedFingerprint"] != nil && q["expectedFingerprint"] != card["sourceFingerprint"] {
		return nil, fail("honor_projection_changed_refresh", 409)
	}
	limit := int(number(q["limit"]))
	if limit == 0 {
		limit = 8
	}
	contributions, cp := idPage(array(view["contributions"]), "assistanceId", str(q, "after"), limit)
	proofs, pp := idPage(array(card["proofs"]), "proofId", str(q, "proofAfter"), limit)
	risk := object(view["riskAssessment"])
	flags := array(risk["flags"])
	offset := int(number(q["riskAfter"]))
	start := min(offset, len(flags))
	riskPage := []any{}
	for _, v := range flags[start:min(len(flags), start+limit)] {
		riskPage = append(riskPage, bounded(v, riskFields))
	}
	out := copyObject(view)
	c := copyObject(card)
	r := copyObject(risk)
	r["flags"] = riskPage
	out["riskAssessment"] = r
	boundedSources := []any{}
	ids := map[string]bool{}
	for _, v := range contributions {
		ids[str(object(v), "assistanceId")] = true
		boundedSources = append(boundedSources, bounded(v, sourceFields))
	}
	out["contributions"] = boundedSources
	evidence := []any{}
	for _, v := range array(card["evidence"]) {
		if ids[str(object(v), "assistanceId")] {
			item := copyObject(v)
			events := array(item["sourceEventIds"])
			item["sourceEventIds"] = events[:min(len(events), 20)]
			item["sourceEventCount"] = len(events)
			evidence = append(evidence, item)
		}
	}
	c["evidence"] = evidence
	c["proofs"] = proofs
	c["evidenceCount"] = len(array(card["evidence"]))
	c["proofCount"] = len(array(card["proofs"]))
	c["evidenceComplete"] = len(contributions) == len(array(view["contributions"]))
	c["proofsComplete"] = len(proofs) == len(array(card["proofs"]))
	out["card"] = c
	var next any
	if offset+limit < len(flags) {
		next = offset + limit
	}
	out["pagination"] = Object{"version": 1, "limit": limit, "consistency": "one-repeatable-read-per-response; refresh rechecks current authorization", "contributions": cp, "proofs": pp, "risks": Object{"after": offset, "nextAfter": next, "total": len(flags)}}
	if id := str(q, "sourceId"); id != "" {
		var source any
		for _, v := range array(view["contributions"]) {
			if str(object(v), "assistanceId") == id {
				source = v
				break
			}
		}
		if source == nil {
			return nil, fail("honor_source_unavailable", 404)
		}
		detail := referencePage(source, sourceFields, int(number(q["sourceAfter"])), limit)
		detail["assistanceId"] = id
		out["sourceDetail"] = detail
	}
	if index, ok := q["riskIndex"]; ok {
		i := int(number(index))
		if i >= len(flags) {
			return nil, fail("honor_risk_unavailable", 404)
		}
		detail := referencePage(flags[i], riskFields, int(number(q["riskReferenceAfter"])), limit)
		detail["index"] = i
		detail["code"] = object(flags[i])["code"]
		out["riskDetail"] = detail
	}
	return out, nil
}
