package cases

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ValidateTaskContextWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, caseID string, attemptRefs []Object) (Object, error) {
	c, e := s.CaseWithin(ctx, tx, caseID)
	if e != nil {
		if fault.Code(e) == "case_unavailable" {
			return nil, fault.New("case_unavailable", 409)
		}
		return nil, e
	}
	if object(c["parent"])["state"] == "withdrawn" {
		return nil, fault.New("case_unavailable", 409)
	}
	rows := c["rows"].([]Object)
	facts := object(c["facts"])
	attempts := []any{}
	for _, ref := range attemptRefs {
		if !reference(ref, false) {
			return nil, fault.New("invalid_attempt_reference", 422)
		}
		found, e := s.RequireFactWithin(ctx, tx, &a, rows, facts, "attempt", ref, FactOptions{})
		if e != nil {
			return nil, e
		}
		attempts = append(attempts, found)
	}
	return object(PublicFacts(Object{"attempts": attempts, "coverage": "specified-references-only"})), nil
}

type DeliveryInput struct {
	TaskID, CaseID, ParticipationID, SubjectID string
	ScopeVersion                               *int64
	ResultRef                                  Object
	InterventionRefs                           []Object
	EvidenceRefs                               []any
}

func (s *Service) ValidateDeliveryWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, in DeliveryInput) (Object, error) {
	if !reference(in.ResultRef, false) {
		return nil, fault.New("invalid_result_reference", 422)
	}
	c, e := s.CaseWithin(ctx, tx, in.CaseID)
	if e != nil {
		if fault.Code(e) == "case_unavailable" {
			return nil, fault.New("case_unavailable", 409)
		}
		return nil, e
	}
	parent := object(c["parent"])
	if parent["state"] == "withdrawn" {
		return nil, fault.New("case_unavailable", 409)
	}
	subject := in.SubjectID
	if subject == "" {
		subject = a.SubjectID
	}
	if a.SubjectID != subject && a.SubjectID != parent["subject_id"] {
		return nil, fault.New("origin_not_authorized", 403)
	}
	rows := c["rows"].([]Object)
	facts := object(c["facts"])
	result, e := s.RequireFactWithin(ctx, tx, &a, rows, facts, "result", in.ResultRef, FactOptions{})
	if e != nil {
		return nil, e
	}
	if result["actorId"] != subject || result["taskId"] != in.TaskID || result["participationId"] != in.ParticipationID {
		return nil, fault.New("origin_not_authorized", 403)
	}
	if in.ScopeVersion != nil && number(result, "participationScopeVersion") != *in.ScopeVersion {
		return nil, fault.New("participation_scope_changed", 409)
	}
	interventions := []any{}
	for _, ref := range in.InterventionRefs {
		v, e := s.RequireFactWithin(ctx, tx, &a, rows, facts, "intervention", ref, FactOptions{})
		if e != nil {
			return nil, e
		}
		interventions = append(interventions, v)
	}
	for _, v := range in.EvidenceRefs {
		if s.Sources == nil {
			return nil, fault.New("source_access_unavailable", 503)
		}
		ref := object(v)
		if id, ok := v.(string); ok {
			ref = Object{"id": id, "version": int64(1)}
		}
		if !reference(ref, false) {
			return nil, fault.New("invalid_evidence_reference", 422)
		}
		ref = copyObject(ref)
		ref["kind"] = "evidence"
		if _, e = s.Sources(ctx, tx, &a, ref, Object{"caseId": in.CaseID, "resultRef": in.ResultRef}); e != nil {
			return nil, e
		}
	}
	return Object{"result": PublicFacts(result), "interventions": PublicFacts(interventions), "evidenceRefs": in.EvidenceRefs}, nil
}
