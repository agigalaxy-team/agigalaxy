package operationsqueries

import "github.com/agigalaxy-team/agigalaxy/go/internal/messaging"

// messageLifecycle projects only the owning domain's current capability facts.
// Unknown capability is distinct from a checked negative, notably for Duty.
func messageLifecycle(plan Object, known bool) Object {
	caps := object(plan["capabilities"])
	projected := Object{}
	options := []any{}
	definitions := []struct{ capability, kind, action, stage, effect string }{
		{"canSave", "message-draft-save", "", "draft-edit", "save-draft-only"},
		{"canActivate", "messaging-state", "activate", "review-delivery-change", "schedule-delivery-after-confirmation"},
		{"canPause", "messaging-state", "pause", "review-delivery-change", "pause-unsent-delivery-after-confirmation"},
		{"canResume", "messaging-state", "resume", "review-delivery-change", "schedule-delivery-after-confirmation"},
		{"canStop", "messaging-state", "stop", "review-delivery-change", "stop-unsent-delivery-after-confirmation"},
		{"canWithdraw", "messaging-state", "withdraw", "review-delivery-change", "withdraw-after-confirmation"},
	}
	for _, definition := range definitions {
		var eligible any
		if value, ok := caps[definition.capability].(bool); known && ok {
			eligible = value
		}
		projected[definition.capability] = eligible
		if definition.capability == "canSave" && eligible != nil {
			if _, ok := plan["state"].(string); ok {
				eligible = messaging.CanPrepareDraftSave(plan)
			} else {
				eligible = nil
			}
		}
		option := Object{"kind": definition.kind, "targetId": plan["id"], "stage": definition.stage, "effect": definition.effect, "eligibleNow": eligible, "requiresHumanConfirmation": true}
		if definition.action != "" {
			option["action"] = definition.action
		}
		options = append(options, option)
	}
	availability := "not-checked"
	if known {
		availability = "available"
	}
	return Object{"state": plan["state"], "effectiveState": plan["effectiveState"], "availability": availability, "objectEligibility": "rechecked-when-preparing", "capabilities": projected, "preparationOptions": options}
}
