package qualification

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ValidatePolicyWithin(ctx context.Context, tx pgx.Tx, ref Object, capability, collaboration string) error {
	_, e := s.PolicyWithin(ctx, tx, str(ref, "policyId"), str(ref, "policyVersion"), capability, collaboration)
	return e
}
func (s *Service) EvaluateLegacyTaskWithin(ctx context.Context, tx pgx.Tx, a taskmaterials.Actor, input Object, collaboration string) (Object, error) {
	raw, e := json.Marshal(input)
	if e != nil {
		return nil, e
	}
	return s.EvaluateWithin(ctx, tx, a.Actor, raw, collaboration)
}

// ValidateParticipationWithin is the real Task selection/confirmation consumer;
// the caller retains its current Task lock, control authorization and transaction.
func (s *Service) ValidateParticipationWithin(ctx context.Context, tx pgx.Tx, a taskmaterials.Actor, task, participation Object) error {
	request := object(task["request"])
	ref := object(request["qualification"])
	if ref == nil {
		return nil
	}
	var application Object
	for _, v := range array(task["applications"]) {
		if object(v)["applicationId"] == participation["applicationId"] {
			application = object(v)
			break
		}
	}
	evidence := application["qualificationEvidence"]
	if ref["profile"] == "facts-v2" {
		if evidence == nil {
			evidence = Object{}
		}
		raw, e := json.Marshal(Object{"taskId": request["taskId"], "subjectId": participation["subjectId"], "policyId": ref["policyId"], "policyVersion": ref["policyVersion"], "capabilityId": request["capabilityId"], "evidence": evidence})
		if e != nil {
			return e
		}
		evaluation, e := s.EvaluateV2Within(ctx, tx, a.Actor, raw, str(request, "collaboration"))
		if e != nil {
			return e
		}
		if evaluation["state"] != "satisfied" {
			return fail("qualification_required", 403)
		}
		return nil
	}
	if evidence == nil {
		evidence = Object{"proofIds": []any{}, "assistanceIds": []any{}}
	}
	query := Object{}
	for k, v := range ref {
		query[k] = v
	}
	query["capabilityId"], query["subjectId"], query["evidence"] = request["capabilityId"], participation["subjectId"], evidence
	raw, e := json.Marshal(query)
	if e != nil {
		return e
	}
	evaluation, e := s.EvaluateWithin(ctx, tx, a.Actor, raw, str(request, "collaboration"))
	if e != nil {
		return e
	}
	if evaluation["eligible"] != true {
		return fail("qualification_required", 403)
	}
	return nil
}
