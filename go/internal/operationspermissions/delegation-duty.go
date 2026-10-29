package operationspermissions

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func (s *Service) delegatedIdentityWithin(ctx context.Context, tx pgx.Tx, a Actor, permission, purpose string) (Actor, string, string, Object, error) {
	if s.Duty != nil && s.Duty.AcceptsDuty(a) {
		if purpose == "prepare" {
			purpose = "execution"
		}
		fresh, e := s.Duty.RequireDutyAction(ctx, tx, a, permission, purpose)
		if e != nil {
			return Actor{}, "", "", nil, e
		}
		metadata, e := s.Duty.DutyMetadata(fresh)
		if e != nil {
			return Actor{}, "", "", nil, e
		}
		return fresh, str(metadata["domain"]), str(metadata["aiAccountId"]), metadata, nil
	}
	c, e := s.humanContext(a)
	if e != nil {
		return Actor{}, "", "", nil, e
	}
	fresh, e := s.HumanAIWithin(ctx, tx, a, c.domain, purpose, permission)
	return fresh, c.domain, c.accountID, nil, e
}

// delegatedReadIdentitiesWithin computes the two purpose projections once for
// read-only capability discovery. Duty authorization stays on its own current
// action checks; human actors use a single fresh snapshot for each purpose.
type delegatedReadIdentities struct {
	query, prepared   Actor
	domain, accountID string
	metadata          Object
}

func (s *Service) delegatedReadIdentitiesWithin(ctx context.Context, tx pgx.Tx, actor Actor) (delegatedReadIdentities, error) {
	var out delegatedReadIdentities
	if s.Duty != nil && s.Duty.AcceptsDuty(actor) {
		query, domain, accountID, metadata, err := s.delegatedIdentityWithin(ctx, tx, actor, "workbench.read", "query")
		if err != nil {
			return out, err
		}
		prepared, _, _, _, err := s.delegatedIdentityWithin(ctx, tx, actor, "workbench.read", "prepare")
		if err != nil {
			return out, err
		}
		return delegatedReadIdentities{query, prepared, domain, accountID, metadata}, nil
	}
	c, err := s.humanContext(actor)
	if err != nil {
		return out, err
	}
	query, err := s.HumanAIReadWithin(ctx, tx, actor, c.domain, "query", "workbench.read")
	if err != nil {
		return out, err
	}
	prepared, err := s.HumanAIReadWithin(ctx, tx, actor, c.domain, "prepare", "workbench.read")
	if err != nil {
		return out, err
	}
	return delegatedReadIdentities{query, prepared, c.domain, c.accountID, nil}, nil
}

func (s *Service) delegatedActorKind(a Actor) string {
	if s.Duty != nil && s.Duty.AcceptsDuty(a) {
		return "operations-ai-service"
	}
	return "business-operator"
}
func (s *Service) delegatedWriters(current delegatedCurrent) (any, any) {
	if s.Duty != nil && s.Duty.AcceptsDuty(current.Actor) {
		return nil, current.Source
	}
	return current.Actor.ID, nil
}
func (s *Service) delegatedAudit(a Actor) (any, any, error) {
	if s.Duty == nil || !s.Duty.AcceptsDuty(a) {
		return a.Role, nil, nil
	}
	ctx, e := DutyAuditContext(s.Duty, a)
	if e != nil {
		return nil, nil, e
	}
	return nil, jsonText(ctx), nil
}

// DutyAuditContext is the original closed audit provenance projection. It can
// only be produced from a currently attested process-local duty actor.
func DutyAuditContext(authority DutyAuthority, a Actor) (Object, error) {
	if authority == nil || !authority.AcceptsDuty(a) {
		return nil, fail("business_admin_audit_actor_unattested", 403)
	}
	metadata, e := authority.DutyMetadata(a)
	if e != nil {
		return nil, e
	}
	o := Object{"schemaVersion": 1, "aiAccountId": metadata["aiAccountId"], "domain": metadata["domain"], "taskId": metadata["taskId"], "planId": metadata["planId"], "planVersion": metadata["planVersion"]}
	bound, source := obj(metadata["operation"]), obj(metadata["auditSource"])
	for _, k := range []string{"grantId", "grantVersion", "strategyId", "strategyVersionId"} {
		if bound[k] != nil {
			o[k] = bound[k]
		}
	}
	if str(source["callId"]) != "" {
		o["toolCallId"], o["toolOperationId"], o["judgmentKind"] = source["callId"], source["operationId"], source["kind"]
	}
	for _, k := range []string{"aiAccountId", "taskId", "planId", "grantId", "strategyId", "strategyVersionId", "toolCallId", "toolOperationId"} {
		if v, ok := o[k]; ok && !validUUID(v) {
			return nil, fail("business_admin_audit_actor_unattested", 403)
		}
	}
	if !contains([]string{"overview", "governance", "messaging", "discovery", "maintenance"}, str(o["domain"])) || !intOK(o["planVersion"], 1) {
		return nil, fail("business_admin_audit_actor_unattested", 403)
	}
	if v, ok := o["grantVersion"]; ok && !intOK(v, 1) {
		return nil, fail("business_admin_audit_actor_unattested", 403)
	}
	if v, ok := o["judgmentKind"]; ok && !contains([]string{"ai", "code"}, str(v)) {
		return nil, fail("business_admin_audit_actor_unattested", 403)
	}
	return o, nil
}
func (s *Service) DelegationAvailabilityWithin(ctx context.Context, tx pgx.Tx, a Actor) (Object, error) {
	return s.delegatedAvailability(ctx, tx, a)
}
