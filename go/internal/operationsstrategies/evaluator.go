package operationsstrategies

// Classify uses only current consumer facts. A rule or model declaration never grants authority.
func Classify(configuration, strategy, facts Object) Object {
	var domain Object
	for _, v := range list(configuration["domains"]) {
		if obj(v)["key"] == strategy["domain"] {
			domain = obj(v)
			break
		}
	}
	checks := []any{}
	check := func(k string, v any) bool {
		state := "unknown"
		if v == true {
			state = "pass"
		} else if v == false {
			state = "fail"
		}
		checks = append(checks, Object{"key": k, "state": state})
		return v == true
	}
	common := check("common-automation", obj(configuration["common"])["automationEnabled"])
	enabledDomain := check("domain-enabled", domain["executionEnabled"])
	enabledStrategy := check("strategy-enabled", strategy["enabled"])
	supported := check("supported-consumer", strategy["template"] == "selected-public-content-visibility" && strategy["domain"] == "governance")
	authority := check("current-authority", facts["authorized"])
	source := check("current-source", facts["sourceAvailable"])
	cas := check("source-and-decision-cas", facts["casMatches"])
	temporal := check("temporal-policy", facts["temporalAllowed"])
	independent := check("prior-decision-boundary", facts["independent"])
	out := func(route, mode, reason string) Object {
		return Object{"route": route, "mode": mode, "reason": reason, "checks": checks, "sideEffects": false}
	}
	if !(common && enabledDomain && enabledStrategy && supported && authority && source && cas && temporal) || !independent {
		reason := "facts-unavailable"
		if !independent {
			reason = "existing-human-or-other-grant-decision"
		} else {
			for _, v := range checks {
				if obj(v)["state"] != "pass" {
					reason = str(obj(v)["key"])
					break
				}
			}
		}
		return out("blocked", "human-led", reason)
	}
	if strategy["condition"] != nil {
		state := "unknown"
		if facts["conditionState"] == "hit" {
			state = "pass"
		} else if facts["conditionState"] == "miss" {
			state = "miss"
		}
		checks = append(checks, Object{"key": "fixed-condition", "state": state})
		if state == "miss" {
			r := out("code", "code-automatic", "fixed-condition-not-matched")
			r["decision"] = "no-action"
			return r
		}
		if state != "pass" {
			return out("blocked", "human-led", "fixed-condition-unknown")
		}
	}
	if strategy["mode"] == "human-led" {
		return out("human", "human-led", "explicit-human-lead")
	}
	if strategy["judgment"] == "semantic" {
		if strategy["mode"] == "code-automatic" {
			return out("blocked", "human-led", "semantic-judgment-not-a-code-rule")
		}
		return out("ai", str(strategy["mode"]), "semantic-judgment-required")
	}
	return out("code", "code-automatic", "frozen-prepared-command")
}
