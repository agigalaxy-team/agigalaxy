package messaging

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// PersistedSourceWithin proves only that this exact continuation was committed
// by the currently active ordinary plan. The autonomy authority must separately
// revalidate the current duty, task, grant, strategy and operation before it can
// return an execution actor. Input metadata alone never supplies an authority.
func (s *Service) PersistedSourceWithin(ctx context.Context, tx pgx.Tx, input Object) (bool, error) {
	operation := obj(input["operation"])
	id := str(operation["targetId"])
	if id == "" || str(operation["permission"]) != "notices.publish" {
		return false, nil
	}
	plan, e := s.planWithin(ctx, tx, id, false)
	if e != nil {
		return false, e
	}
	return persistedApprovalSource(plan, input), nil
}
func persistedApprovalSource(plan, input Object) bool {
	operation := obj(input["operation"])
	id := str(operation["targetId"])
	stored := obj(plan["approved_ai"])
	automation := obj(obj(plan["config"])["automation"])
	if id == "" || str(operation["permission"]) != "notices.publish" || stored == nil || str(plan["state"]) != "active" || num(stored["messageVersion"]) != num(plan["version"]) || str(stored["messagePlanId"]) != id || str(plan["approved_by"]) != "ai:"+str(input["aiAccountId"]) || plan["approved_role"] != nil || str(automation["kind"]) != "ordinary" || !boolValue(automation["factsConfirmed"]) {
		return false
	}
	metadata := obj(clone(stored))
	delete(metadata, "messagePlanId")
	delete(metadata, "messageVersion")
	clean := obj(clone(input))
	delete(clean, "continuation")
	delete(clean, "businessAction")
	delete(clean, "selection")
	return same(metadata, clean)
}
