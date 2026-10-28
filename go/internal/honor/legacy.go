package honor

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"sort"
)

func (s *Service) projectLegacy(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, q Object, includeRisk bool, selected *selectedRule, sourceResult *legacySources) (Object, error) {
	var chosen selectedRule
	var e error
	if selected == nil {
		chosen, e = s.selectRule(ctx, tx, str(q, "ruleId"), str(q, "ruleVersion"), nil, nil)
		if e != nil {
			return nil, e
		}
	} else {
		chosen = *selected
	}
	rule := chosen.Rule
	subject := str(q, "subjectId")
	now := s.now()
	if rule["sourceProfile"] == "facts-v2" {
		return nil, fail("unsupported_semantics", 409)
	}
	if !has(rule["members"], subject) {
		return nil, fail("honor_subject_outside_scope", 404)
	}
	cache := map[string]Object{}
	var sources legacySources
	if sourceResult == nil {
		sources, e = s.legacySources(ctx, tx, a, subject, rule, false, true, cache)
		if e != nil {
			return nil, e
		}
	} else {
		sources = *sourceResult
	}
	eligible := []Object{}
	caseIDs := map[string]bool{}
	related := map[string]bool{}
	accepted, canceled, disputed, paused := 0, 0, 0, 0
	contributions := []any{}
	for _, v := range sources.Contributions {
		contributions = append(contributions, orderedLegacySource(v))
		if v["accepted"] == true {
			accepted++
		}
		if v["state"] == "canceled" {
			canceled++
		}
		if v["disputed"] == true {
			disputed++
		}
		if v["paused"] == true {
			paused++
		}
		if v["eligible"] == true && (rule["kind"] != "open-contributor" || v["collaboration"] == "open-assistance") {
			eligible = append(eligible, v)
			caseIDs[str(v, "caseId")] = true
			if v["independence"] == "issuer-declared-related-party" {
				related[str(v, "caseId")] = true
			}
		}
	}
	proofs := uniqueProofs(eligible)
	status := "insufficient-evidence"
	if !chosen.Configured || now < number(rule["notBefore"]) || now >= number(rule["notAfter"]) || rule["revoked"] == true {
		status = "inactive-rule"
	} else if !sources.Complete {
		status = "incomplete-source-scan"
	} else if len(caseIDs) >= int(number(rule["minAcceptedCases"])) && len(proofs) >= int(number(rule["minProofs"])) {
		status = "active"
	}
	idRaw, _ := protocol.EncodeJS([]any{s.Endpoint, subject, rule["id"], rule["version"]})
	ruleRaw, e := protocol.EncodeJS(orderedRule(rule))
	if e != nil {
		return nil, e
	}
	evidence := []any{}
	for _, v := range eligible {
		ids := []any{}
		for _, ev := range array(v["sourceEvents"]) {
			ids = append(ids, object(ev)["eventId"])
		}
		evidence = append(evidence, Object{"assistanceId": v["assistanceId"], "caseId": v["caseId"], "sourceEventIds": ids, "independence": v["independence"]})
	}
	projectionRule := ordered("id", "honor-contribution", "version", 2)
	card := Object{"id": identity.Digest(idRaw), "subjectId": subject, "issuer": s.Endpoint, "rule": s.publicRule(rule, false), "ruleHash": identity.Digest(ruleRaw), "projectionRule": projectionRule, "status": status, "evidence": evidence, "proofs": proofs, "acceptedCases": len(caseIDs), "checkedAt": now, "cacheable": false, "capabilityVerified": false, "statusUrl": s.Endpoint + "/v1/honor/" + subject + "/" + str(rule, "id") + "/" + str(rule, "version"), "freshness": "Read statusUrl with current source authorization. A screenshot is not current evidence.", "sharing": "Source visibility applies to every viewer; this card does not grant access."}
	if chosen.Registry != nil {
		card["registry"] = chosen.Registry
	}
	var risk any
	var flags any
	if includeRisk {
		network := legacySources{Contributions: []Object{}, Complete: sources.Complete}
		if len(sources.Contributions) > 0 {
			network, e = s.legacySources(ctx, tx, a, subject, rule, true, false, cache)
			if e != nil {
				return nil, e
			}
		}
		r := AssessRisk(sources.Contributions, sources.Complete, now, subject, &network)
		risk = r
		flags = r.Values()["flags"]
	}
	raw, e := protocol.EncodeJS(ordered("projectionRule", projectionRule, "ruleHash", card["ruleHash"], "contributions", contributions, "status", status, "riskFlags", flags))
	if e != nil {
		return nil, e
	}
	card["sourceFingerprint"] = identity.Digest(raw)
	return Object{"card": card, "contributions": contributions, "complete": sources.Complete, "riskAssessment": risk, "facets": Object{"contribution": Object{"acceptedCases": len(caseIDs), "relatedPartyCases": len(related)}, "capabilityEvidence": Object{"proofCount": len(proofs), "strength": "ci-execution-fact", "capabilityVerified": false}, "collaborationReliability": Object{"accepted": accepted, "canceled": canceled, "disputed": disputed, "paused": paused, "coverage": "visible collaborations in the configured capability/community/window; not global reliability"}, "requesterReputation": Object{"method": "separate participant-reported requester history", "path": "/v1/requester-history/query"}}, "globalScore": nil}, nil
}

func (s *Service) Query(ctx context.Context, a *Actor, input Object) (Object, error) {
	q, e := parseQuery(input, false)
	if e != nil {
		return nil, e
	}
	return s.read(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		var actor *deviceauth.Actor
		if a != nil {
			actor = &a.Actor
		}
		v, e := s.projectLegacy(ctx, tx, actor, q, true, nil, nil)
		if e != nil {
			return nil, e
		}
		return paginate(v, q)
	})
}

func (s *Service) Ranking(ctx context.Context, input Object) (Object, error) {
	q, e := parseRanking(input)
	if e != nil {
		return nil, e
	}
	return s.read(ctx, nil, true, func(tx pgx.Tx) (Object, error) {
		selected, e := s.selectRule(ctx, tx, str(q, "ruleId"), str(q, "ruleVersion"), nil, nil)
		if e != nil {
			return nil, e
		}
		rule := selected.Rule
		now := s.now()
		if rule["sourceProfile"] == "facts-v2" {
			return nil, fail("unsupported_semantics", 409)
		}
		base := Object{"issuer": s.Endpoint, "rule": s.publicRule(rule, false), "projectionRule": Object{"id": "honor-contribution", "version": 2}, "checkedAt": now, "cacheable": false, "capabilityVerified": false, "qualificationGranted": false, "benchmarkConclusion": nil, "method": "public-source distinct accepted Cases, scoped cohort only; ties share rank"}
		suppress := func(reason string) (Object, error) {
			base["status"] = "suppressed"
			base["reason"] = reason
			base["items"] = []any{}
			return base, nil
		}
		if rule["rankingEnabled"] != true || rule["privacyReview"] != "approved" {
			return suppress("ranking-not-approved")
		}
		if !selected.Configured || rule["revoked"] == true || now < number(rule["notBefore"]) || now >= number(rule["notAfter"]) || now < number(rule["windowUntil"]) {
			return suppress("rule-inactive-or-window-open")
		}
		all, e := s.legacySources(ctx, tx, nil, "", rule, true, true, map[string]Object{})
		if e != nil {
			return nil, e
		}
		grouped := map[string][]Object{}
		for _, v := range all.Contributions {
			subject := str(v, "subjectId")
			grouped[subject] = append(grouped[subject], v)
		}
		members := []string{}
		for _, v := range array(rule["members"]) {
			members = append(members, text(v))
		}
		col := collate.New(language.English)
		sort.SliceStable(members, func(i, j int) bool { return col.CompareString(members[i], members[j]) < 0 })
		entries := []Object{}
		for _, subject := range members {
			ss := legacySources{Contributions: grouped[subject], Complete: all.Complete}
			if ss.Contributions == nil {
				ss.Contributions = []Object{}
			}
			v, e := s.projectLegacy(ctx, tx, nil, Object{"ruleId": rule["id"], "ruleVersion": rule["version"], "subjectId": subject}, false, &selected, &ss)
			if e != nil {
				return nil, e
			}
			if v["complete"] != true {
				return suppress("incomplete-source-scan")
			}
			card := object(v["card"])
			if card["status"] == "active" && number(card["acceptedCases"]) >= number(rule["minimumCasesPerMember"]) {
				entries = append(entries, Object{"subjectId": subject, "acceptedCases": card["acceptedCases"], "relatedPartyCases": object(object(v["facets"])["contribution"])["relatedPartyCases"], "statusUrl": card["statusUrl"]})
			}
		}
		if len(entries) < int(number(rule["minimumCohort"])) {
			return suppress("insufficient-public-cohort")
		}
		sort.SliceStable(entries, func(i, j int) bool {
			if number(entries[i]["acceptedCases"]) != number(entries[j]["acceptedCases"]) {
				return number(entries[i]["acceptedCases"]) > number(entries[j]["acceptedCases"])
			}
			return col.CompareString(str(entries[i], "subjectId"), str(entries[j], "subjectId")) < 0
		})
		rank, total := 0, int64(0)
		items := []any{}
		for i, v := range entries {
			if i == 0 || number(v["acceptedCases"]) != number(entries[i-1]["acceptedCases"]) {
				rank = i + 1
			}
			v["rank"] = rank
			total += number(v["acceptedCases"])
			items = append(items, v)
		}
		base["status"] = "published"
		base["items"] = items
		base["statistics"] = Object{"cohort": len(items), "acceptedCases": total, "population": "policy-eligible publicly visible cohort", "industryComparison": false}
		return base, nil
	})
}
