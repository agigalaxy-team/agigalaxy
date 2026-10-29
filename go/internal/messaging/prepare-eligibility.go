package messaging

// CanPrepareDraftSave is the existing human-card eligibility condition; it
// does not authorize preparation or validate a submitted configuration.
func CanPrepareDraftSave(plan Object) bool {
	return plan["state"] == "draft" && obj(plan["capabilities"])["canSave"] == true
}
