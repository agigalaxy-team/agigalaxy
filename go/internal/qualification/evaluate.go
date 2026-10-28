package qualification

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var capabilityPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)
var uuidPattern = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func queryClosed(input Object, required, optional []string) bool {
	allowed := map[string]bool{}
	for _, key := range required {
		if _, ok := input[key]; !ok {
			return false
		}
		allowed[key] = true
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key := range input {
		if !allowed[key] {
			return false
		}
	}
	return input != nil
}
func boundedString(value any, min, max int) bool {
	s, ok := value.(string)
	n := utf8.RuneCountInString(s)
	return ok && n >= min && n <= max
}
func uniqueIDs(value any, max int) bool {
	values, ok := value.([]any)
	if !ok || len(values) > max {
		return false
	}
	seen := map[string]bool{}
	for _, value := range values {
		id, ok := value.(string)
		if !ok || !uuidPattern.MatchString(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}
func ParseQuery(raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || !queryClosed(q, []string{"policyId", "policyVersion", "capabilityId", "evidence"}, []string{"subjectId"}) ||
		!boundedString(q["policyId"], 1, 80) || !boundedString(q["policyVersion"], 1, 32) || !capabilityPattern.MatchString(str(q, "capabilityId")) {
		return nil, fail("invalid_qualification_query", 400)
	}
	if value, exists := q["subjectId"]; exists {
		if _, ok := value.(string); !ok || !subjectPattern.MatchString(text(value)) {
			return nil, fail("invalid_qualification_query", 400)
		}
	}
	e := object(q["evidence"])
	if !queryClosed(e, []string{"proofIds", "assistanceIds"}, nil) || !uniqueIDs(e["proofIds"], 16) || !uniqueIDs(e["assistanceIds"], 16) {
		return nil, fail("invalid_qualification_query", 400)
	}
	return q, nil
}
func serviceError(e error) bool { var f *fault.Error; return errors.As(e, &f) }
func englishSort(values []string) {
	c := collate.New(language.English)
	sort.SliceStable(values, func(i, j int) bool { return c.CompareString(values[i], values[j]) < 0 })
}
func stringsIn(value any) []string {
	result := []string{}
	for _, v := range array(value) {
		result = append(result, text(v))
	}
	return result
}
func hasString(value any, s string) bool {
	for _, v := range array(value) {
		if v == s {
			return true
		}
	}
	return false
}

// EvaluateWithin recomputes original policy-specific eligibility from selected,
// currently readable sources. It does not infer individual professional ability.
func (s *Service) EvaluateWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, raw []byte, collaboration string) (Object, error) {
	q, e := ParseQuery(raw)
	if e != nil {
		return nil, e
	}
	subject := a.SubjectID
	if v, ok := q["subjectId"]; ok {
		subject = text(v)
	}
	policy, e := s.PolicyWithin(ctx, tx, str(q, "policyId"), str(q, "policyVersion"), str(q, "capabilityId"), collaboration)
	if e != nil {
		return nil, e
	}
	now := s.now()
	accepted := []any{}
	eligible := []any{}
	observations := []any{}
	unavailable := []any{}
	ids := stringsIn(object(q["evidence"])["assistanceIds"])
	englishSort(ids)
	for _, id := range ids {
		if s.Assistance == nil {
			return nil, fail("qualification_assistance_unavailable", 503)
		}
		item, err := s.acceptedWithin(ctx, tx, a, id, subject, policy, now)
		if err != nil {
			if !serviceError(err) {
				return nil, err
			}
			unavailable = append(unavailable, Object{"kind": "assistance", "id": id})
			continue
		}
		if item != nil {
			accepted = append(accepted, item)
		}
	}
	for _, id := range stringsIn(object(q["evidence"])["proofIds"]) {
		if s.Proofs == nil {
			return nil, fail("qualification_proof_unavailable", 503)
		}
		proof, err := s.proofWithin(ctx, tx, a, id, subject, policy, now, accepted)
		if err != nil {
			if !serviceError(err) {
				return nil, err
			}
			unavailable = append(unavailable, Object{"kind": "proof", "id": id})
			continue
		}
		if proof != nil {
			observations = append(observations, proof)
			if policy["requireCiSuccess"] != true || proof["conclusion"] == "success" {
				eligible = append(eligible, proof)
			}
		}
	}
	proofs := ContributionProofs(eligible, observations)
	byCase := map[string]Object{}
	collaborations := []any{}
	for _, v := range accepted {
		item := object(v)
		key := str(item, "caseId")
		group := byCase[key]
		if group == nil {
			group = Object{}
			for k, v := range item {
				if k != "evidenceIds" {
					group[k] = v
				}
			}
			group["relatedAssistanceIds"] = []any{}
			byCase[key] = group
			collaborations = append(collaborations, group)
		}
		group["relatedAssistanceIds"] = append(array(group["relatedAssistanceIds"]), item["assistanceId"])
	}
	reasons := []any{}
	if int64(len(proofs)) < number(policy["minProofs"]) {
		reasons = append(reasons, "insufficient-policy-matched-proof")
	}
	if int64(len(collaborations)) < number(policy["minAcceptedCollaborations"]) {
		reasons = append(reasons, "insufficient-related-accepted-history")
	}
	hash, e := DefinitionHash(policy)
	if e != nil {
		return nil, e
	}
	return Object{"subjectId": subject, "capabilityId": policy["capabilityId"], "policyId": policy["id"], "policyVersion": policy["version"], "issuer": s.Endpoint, "eligible": len(reasons) == 0, "reasons": reasons, "proofs": proofs, "acceptedCollaborations": collaborations, "unavailable": unavailable,
		"evaluationRule":       Object{"id": "capability-participation", "version": 2, "historyCounting": "distinct-case", "proofCounting": "distinct-current-ci-source; conflicting-commit-or-conclusion-excluded"},
		"policyDefinitionHash": hash, "registeredPolicyVersion": s.registryEnabled, "evaluatedAt": now, "cacheable": false, "scope": "policy-specific-participation", "capabilityVerified": false,
		"limitations": []any{"CI facts do not establish individual task quality.", "Acceptance and capability association are participant-reported.", "Recomputed on selection and provider confirmation."}}, nil
}
func (s *Service) acceptedWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id, subject string, policy Object, now int64) (Object, error) {
	loaded, e := s.Assistance.LegacyLoadWithin(ctx, tx, id, true)
	if e != nil {
		return nil, e
	}
	state := object(loaded.Row["snapshot"])
	request := object(state["request"])
	if loaded.Paused || !s.Assistance.LegacySourceVisible(loaded.Grants[id], a.SubjectID) || state["state"] != "accepted" || object(state["selected"])["providerId"] != subject || request["capabilityId"] != policy["capabilityId"] || number(state["createdAt"]) < now-number(policy["historyWindowSeconds"]) {
		return nil, nil
	}
	revisions, e := s.Assistance.LegacyCaseReviewEventsWithin(ctx, tx, str(loaded.Row, "case_id"), a.SubjectID)
	if e != nil {
		return nil, e
	}
	review := taskmaterials.LegacyReviewProjection(revisions, state)
	confirmation := Object(nil)
	for _, v := range array(state["events"]) {
		r := object(v)
		if object(r["event"])["kind"] == "confirm" && r["actorId"] == subject {
			confirmation = r
			break
		}
	}
	if review["accepted"] != true || review["correctionPending"] == true || review["disputed"] == true || confirmation == nil {
		return nil, nil
	}
	delivery := object(state["delivery"])
	acceptance := object(object(review["acceptance"])["event"])
	for _, eventID := range []string{str(object(confirmation["event"]), "id"), str(delivery, "id"), str(acceptance, "id")} {
		if !s.Assistance.LegacySourceVisible(loaded.Grants[eventID], a.SubjectID) {
			return nil, nil
		}
	}
	evidenceIDs := delivery["evidenceIds"]
	if evidenceIDs == nil {
		evidenceIDs = []any{}
	}
	return Object{"assistanceId": id, "caseId": request["caseId"], "evidenceIds": evidenceIDs, "deliveryEventId": delivery["id"], "acceptanceEventId": acceptance["id"], "caseReviewVersion": delivery["caseReviewVersion"]}, nil
}
func (s *Service) proofWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id, subject string, policy Object, now int64, accepted []any) (Object, error) {
	visible, e := s.Proofs.ReadWithin(ctx, tx, &a, id, false)
	if e != nil {
		return nil, e
	}
	if object(visible["caseContext"])["status"] == "active-dispute" {
		return nil, nil
	}
	var payloadText, owner, evidenceID string
	if e = tx.QueryRow(ctx, "SELECT payload_text,subject_id,evidence_id FROM proofs WHERE id=$1", id).Scan(&payloadText, &owner, &evidenceID); e != nil {
		return nil, e
	}
	var payload Object
	if e = json.Unmarshal([]byte(payloadText), &payload); e != nil {
		return nil, e
	}
	var held, revision bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM moderation_reports m JOIN evidence_submissions e ON e.case_id=m.case_id WHERE e.id=$1 AND m.paused=true),EXISTS(SELECT 1 FROM case_events e JOIN evidence_submissions v ON v.case_id=e.case_id WHERE v.id=$1 AND e.kind='revision')", evidenceID).Scan(&held, &revision); e != nil {
		return nil, e
	}
	if held || revision && visible["caseContext"] == nil || number(payload["observedAt"]) < now-number(policy["historyWindowSeconds"]) {
		return nil, nil
	}
	source := object(payload["source"])
	matched := false
	for _, v := range array(policy["repositories"]) {
		repo := object(v)
		if strings.EqualFold(str(repo, "owner"), str(source, "owner")) && strings.EqualFold(str(repo, "repository"), str(source, "repository")) {
			matched = true
			break
		}
	}
	if !matched {
		return nil, nil
	}
	if owner != subject {
		related := false
		for _, v := range accepted {
			if hasString(object(v)["evidenceIds"], evidenceID) {
				related = true
				break
			}
		}
		if !related {
			return nil, nil
		}
	}
	return Object{"proofId": id, "evidenceId": evidenceID, "sourceKey": object(visible["provenance"])["sourceKey"], "commit": source["commit"], "conclusion": payload["conclusion"], "strength": "ci-execution-fact", "attribution": payload["attribution"]}, nil
}

// ContributionProofs preserves the existing distinct verified CI source rule;
// conflicting commit or conclusion observations never establish support.
func ContributionProofs(eligible, observations []any) []any {
	eligibleIDs := map[string]bool{}
	for _, v := range eligible {
		eligibleIDs[str(object(v), "proofId")] = true
	}
	groups := map[string][]Object{}
	order := []string{}
	for _, v := range observations {
		p := object(v)
		key := str(p, "sourceKey")
		if p["sourceKey"] == nil {
			key = str(p, "evidenceId")
		}
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], p)
	}
	result := []any{}
	c := collate.New(language.English)
	for _, key := range order {
		records := groups[key]
		valid := true
		for _, p := range records {
			if p["commit"] != records[0]["commit"] || p["conclusion"] != records[0]["conclusion"] {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		sort.SliceStable(records, func(i, j int) bool {
			return c.CompareString(str(records[i], "proofId"), str(records[j], "proofId")) < 0
		})
		for _, p := range records {
			if eligibleIDs[str(p, "proofId")] {
				result = append(result, p)
				break
			}
		}
	}
	key := func(p Object) string {
		if p["sourceKey"] != nil {
			return str(p, "sourceKey")
		}
		return str(p, "evidenceId")
	}
	sort.SliceStable(result, func(i, j int) bool { return c.CompareString(key(object(result[i])), key(object(result[j]))) < 0 })
	return result
}
func (s *Service) Evaluate(ctx context.Context, a Actor, raw []byte) (any, error) {
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) { return s.EvaluateWithin(ctx, tx, a.Actor, raw, "") })
}
