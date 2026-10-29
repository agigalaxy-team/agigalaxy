package operationsaccounts

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"time"
	"unicode/utf8"
)

// NormalizeRestrictionRequest is the shared closed action-request contract.
func NormalizeRestrictionRequest(input Object) (Object, error) {
	if !strict(input, []string{"kind", "targetId", "action", "reason"}, []string{"until"}) || input["kind"] != "account-restriction" || !validID(str(input["targetId"])) {
		return nil, invalid()
	}
	action := str(input["action"])
	until, present := input["until"]
	if (action != "apply" && action != "release") || (action == "apply") != present {
		return nil, invalid()
	}
	reason, ok := input["reason"].(string)
	if !ok {
		return nil, invalid()
	}
	reason = businessadmin.TrimActionText(reason)
	if n := utf8.RuneCountInString(reason); n < 3 || n > 2000 {
		return nil, invalid()
	}
	if present {
		value, ok := until.(string)
		if !ok {
			return nil, invalid()
		}
		if _, e := time.Parse(time.RFC3339Nano, value); e != nil {
			return nil, invalid()
		}
	}
	out := Object{}
	for k, v := range input {
		out[k] = v
	}
	out["reason"] = reason
	return out, nil
}
