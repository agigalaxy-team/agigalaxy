package operationsautonomy

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// ContinuationActorWithin reconstructs an AI execution identity only from an
// exact committed approval matched by the owning business domain, followed by
// the original current task/grant/strategy gates. Metadata alone is no credential.
func (s *Service) ContinuationActorWithin(ctx context.Context, tx pgx.Tx, input Object) (Actor, error) {
	operation := obj(input["operation"])
	if num(input["contextSchemaVersion"]) != 1 || input["endpoint"] != s.Endpoint || str(operation["operationId"]) == "" || str(operation["permission"]) == "" || input["accessPurpose"] != "execution" || s.PersistedSourceWithin == nil {
		return Actor{}, dutyFail("operations_ai_duty_operation_denied")
	}
	in := DutyInput{Domain: str(input["domain"]), AIAccountID: str(input["aiAccountId"]), TaskID: str(input["taskId"]), Purpose: str(input["purpose"]), AccessPurpose: "execution", PlanID: str(input["planId"]), PlanVersion: num(input["planVersion"]), ResourceIDs: texts(input["resourceIds"])}
	if input["delegationVersion"] != nil {
		v := num(input["delegationVersion"])
		in.DelegationVersion = &v
	}
	p := &dutyProof{owner: s, input: in, audit: obj(clone(input["auditSource"])), operation: obj(clone(operation)), stored: obj(clone(input)), continuation: true}
	if _, e := s.validatePersistedWithin(ctx, tx, p, nil, nil); e != nil {
		return Actor{}, e
	}
	return s.currentDuty(ctx, tx, p)
}
func (s *Service) validatePersistedWithin(ctx context.Context, tx pgx.Tx, p *dutyProof, businessAction *string, selection Object) (Object, error) {
	if s.PersistedSourceWithin == nil {
		return nil, dutyFail("operations_ai_duty_operation_denied")
	}
	metadata := obj(clone(p.stored))
	metadata["continuation"] = true
	if businessAction != nil {
		metadata["businessAction"] = *businessAction
	}
	if selection != nil {
		metadata["selection"] = clone(selection)
	}
	matched, e := s.PersistedSourceWithin(ctx, tx, metadata)
	if e != nil {
		return nil, e
	}
	if !matched {
		return nil, dutyFail("operations_ai_duty_operation_denied")
	}
	operation := objectOperation(p.operation)
	operation.BusinessAction = businessAction
	return s.authorizeOperationWithin(ctx, tx, Actor{}, p, operation, true, true)
}
