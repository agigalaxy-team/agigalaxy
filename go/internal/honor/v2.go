package honor

import (
	"context"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

func uniqueProofs(sources []Object) []any {
	eligible, observations := []any{}, []any{}
	originals := map[string]any{}
	for _, source := range sources {
		for _, v := range array(source["proofs"]) {
			p := object(v)
			eligible = append(eligible, p)
			originals[str(p, "proofId")] = v
		}
		for _, v := range array(source["observations"]) {
			p := object(v)
			observations = append(observations, p)
			originals[str(p, "proofId")] = v
		}
	}
	result := []any{}
	for _, v := range qualification.ContributionProofs(eligible, observations) {
		result = append(result, originals[str(object(v), "proofId")])
	}
	return result
}
func publicV2Item(source Object) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, key := range []string{"id", "subjectId", "eligible", "sourceStatus", "projections", "proofs", "observations", "independence", "contributionMeaning"} {
		out.Set(key, source[key])
	}
	return out
}
func (s *Service) selectV2(ctx context.Context, tx pgx.Tx, id, version string, state Object) (selectedRule, error) {
	selected, e := s.selectRule(ctx, tx, id, version, state, nil)
	if e != nil {
		return selected, e
	}
	if selected.Rule["sourceProfile"] != "facts-v2" {
		return selected, fail("honor_source_profile_mismatch")
	}
	return selected, nil
}
func (s *Service) projectV2(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, q Object, selected *selectedRule, sources []Object) (Object, error) {
	var chosen selectedRule
	var e error
	if selected == nil {
		chosen, e = s.selectV2(ctx, tx, str(q, "ruleId"), str(q, "ruleVersion"), nil)
		if e != nil {
			return nil, e
		}
	} else {
		chosen = *selected
	}
	policy := chosen.Rule
	subject := str(q, "subjectId")
	if !has(policy["members"], subject) {
		return nil, fail("honor_subject_outside_scope", 404)
	}
	if sources == nil {
		sources, e = s.v2Sources(ctx, tx, a, subject, policy)
		if e != nil {
			return nil, e
		}
	}
	valid := []Object{}
	cases := map[string]bool{}
	for _, source := range sources {
		if source["eligible"] == true {
			valid = append(valid, source)
			cases[text(source["_caseId"])] = true
		}
	}
	proofs := uniqueProofs(valid)
	active := chosen.Configured && policy["revoked"] != true && number(policy["notBefore"]) <= s.now() && number(policy["notAfter"]) > s.now()
	status := "insufficient-evidence"
	if !active {
		status = "inactive-rule"
	} else if int64(len(cases)) >= number(policy["minAcceptedCases"]) && int64(len(proofs)) >= number(policy["minProofs"]) {
		status = "active"
	}
	publicItems := []any{}
	for _, source := range sources {
		publicItems = append(publicItems, publicV2Item(source))
	}
	_, definitionHash, e := Definition(policy)
	if e != nil {
		return nil, e
	}
	fingerprint, e := historyv2.SourceFingerprint(ordered("publicItems", publicItems, "definitionHash", definitionHash, "status", status))
	if e != nil {
		return nil, e
	}
	if expected := str(q, "expectedFingerprint"); expected != "" && expected != fingerprint {
		return nil, fail("honor_sources_changed_retry")
	}
	start := 0
	if after := str(q, "after"); after != "" {
		found := false
		for i, source := range sources {
			if source["id"] == after {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return nil, fail("invalid_honor_cursor")
		}
	}
	limit := int(number(q["limit"]))
	if limit == 0 {
		limit = 8
	}
	items := publicItems[start:min(len(publicItems), start+limit)]
	var next any
	if start+len(items) < len(publicItems) {
		next = object(items[len(items)-1])["id"]
	}
	idRaw, _ := protocol.EncodeJS([]any{s.Endpoint, subject, policy["id"], policy["version"], "facts-v2"})
	card := Object{"id": identity.Digest(idRaw), "subjectId": subject, "issuer": s.Endpoint, "rule": s.publicRule(policy, true), "definitionHash": definitionHash, "status": status, "checkedAt": s.now(), "cacheable": false, "acceptedCases": len(cases), "proofs": proofs, "capabilityVerified": false, "qualificationGranted": false, "statusUrl": s.Endpoint + "/v2/honor/" + subject + "/" + str(policy, "id") + "/" + str(policy, "version"), "sharing": "Selected contribution projections only; this card grants no original-text access."}
	if chosen.Registry != nil {
		card["registry"] = chosen.Registry
	}
	result := Object{"schemaVersion": 2, "card": card, "items": items, "nextAfter": next, "sourceFingerprint": fingerprint, "counts": Object{"realDistinctAcceptedCases": len(cases), "policyMatchedCiSources": len(proofs)}, "complete": true, "coverage": "all currently permitted matching participation sources in the selected rule/window; not global history", "globalScore": nil}
	if policy["kind"] == "ci-backed-contributor" {
		state := "awaiting-v2-verified-proof-link-adapter"
		if s.CI != nil {
			state = "native-v2-current-proof-binding"
		}
		result["ciEvidenceSupport"] = Object{"state": state, "reportedCiLabelCountsAsVerified": false}
	}
	if q["includeSimulation"] == true {
		simulated := map[string]bool{}
		for _, source := range sources {
			if source["_eligible"] == true {
				simulated[text(source["_caseId"])] = true
			}
		}
		result["simulation"] = Object{"only": true, "grantsHonor": false, "distinctCases": len(simulated)}
	}
	return result, nil
}
func (s *Service) QueryV2(ctx context.Context, a *Actor, input Object) (Object, error) {
	q, e := parseQuery(input, true)
	if e != nil {
		return nil, e
	}
	return s.read(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		var actor *deviceauth.Actor
		if a != nil {
			actor = &a.Actor
		}
		return s.projectV2(ctx, tx, actor, q, nil, nil)
	})
}
func (s *Service) RankingV2(ctx context.Context, input Object) (Object, error) {
	q, e := parseRanking(input)
	if e != nil {
		return nil, e
	}
	return s.read(ctx, nil, true, func(tx pgx.Tx) (Object, error) {
		var state Object
		if s.registryEnabled {
			var e error
			state, e = CurrentRegistryWithin(ctx, tx, s.Endpoint)
			if e != nil {
				return nil, e
			}
		}
		selected, e := s.selectV2(ctx, tx, str(q, "ruleId"), str(q, "ruleVersion"), state)
		if e != nil {
			return nil, e
		}
		p := selected.Rule
		base := Object{"schemaVersion": 2, "issuer": s.Endpoint, "rule": s.publicRule(p, true), "checkedAt": s.now(), "qualificationGranted": false, "capabilityVerified": false, "globalScore": nil}
		suppressed := func(reason string) (Object, error) {
			base["status"], base["reason"], base["items"] = "suppressed", reason, []any{}
			return base, nil
		}
		if p["rankingEnabled"] != true || p["privacyReview"] != "approved" {
			return suppressed("ranking-not-approved")
		}
		if !selected.Configured || p["revoked"] == true || s.now() < number(p["notBefore"]) || s.now() >= number(p["notAfter"]) || s.now() < number(p["windowUntil"]) {
			return suppressed("rule-inactive-or-window-open")
		}
		rows := []Object{}
		for _, v := range array(p["members"]) {
			subject := text(v)
			view, e := s.projectV2(ctx, tx, nil, Object{"ruleId": q["ruleId"], "ruleVersion": q["ruleVersion"], "subjectId": subject, "limit": 1}, &selected, nil)
			if e != nil {
				return nil, e
			}
			card := object(view["card"])
			if card["status"] == "active" && number(card["acceptedCases"]) >= number(p["minimumCasesPerMember"]) {
				rows = append(rows, Object{"subjectId": subject, "acceptedCases": card["acceptedCases"], "statusUrl": card["statusUrl"]})
			}
		}
		if int64(len(rows)) < number(p["minimumCohort"]) {
			return suppressed("insufficient-public-cohort")
		}
		c := collate.New(language.English)
		sort.SliceStable(rows, func(i, j int) bool {
			if a, b := number(rows[i]["acceptedCases"]), number(rows[j]["acceptedCases"]); a != b {
				return a > b
			}
			return c.CompareString(str(rows[i], "subjectId"), str(rows[j], "subjectId")) < 0
		})
		rank := 0
		items := []any{}
		for i, row := range rows {
			if i == 0 || number(row["acceptedCases"]) != number(rows[i-1]["acceptedCases"]) {
				rank = i + 1
			}
			row["rank"] = rank
			items = append(items, row)
		}
		base["status"], base["items"], base["method"] = "published", items, "real public distinct accepted Cases within this rule; ties share rank; not skill or industry ranking"
		return base, nil
	})
}
