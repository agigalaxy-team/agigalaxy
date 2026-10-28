package businessrules

// EvaluateDetailed is the side-effect-free original P14 sample trace. Its
// policy is the normalized controls object supplied by the owning schema.
// Production predicates and this trace share conditionEnvironment.
func EvaluateDetailed(policy, input Object) (Object, error) {
	target := str(input, "target")
	feature := map[string]string{"forum-post": "forumPost", "forum-reply": "forumReply", "forum-upload": "attachmentUpload", "chat-message": "chatSend", "chat-upload": "attachmentUpload"}[target]
	enabled, ok := obj(policy, "features")[feature].(bool)
	if feature == "" || !ok || str(policy, "schema") != "business-controls/1" {
		return nil, fail("invalid_operations_rule_request", 400)
	}
	lists, ok := objects(policy["lists"])
	if !ok {
		return nil, fail("invalid_operations_rule_request", 400)
	}
	byID := map[string]Object{}
	for _, l := range lists {
		byID[str(l, "id")] = l
	}
	rules, ok := objects(policy["rules"])
	if !ok {
		return nil, fail("invalid_operations_rule_request", 400)
	}
	text, hasText := input["text"].(string)
	links, _ := input["links"].([]any)
	hosts, count := linkFacts(text, links)
	if !hasText && links == nil {
		count = nil
	}
	var supplied *string
	if hasText {
		supplied = &text
	}
	facts := ContentConditionFacts(supplied, links, nil)
	for _, k := range []string{"accountTier", "subjectType", "attachmentCount", "fileBytes"} {
		facts[k] = input[k]
	}
	traces := []Object{}
	matchedIDs, exceptionIDs, missing := []string{}, []string{}, []string{}
	missingSet := map[string]bool{}
	addMissing := func(k string) {
		if !missingSet[k] {
			missingSet[k] = true
			missing = append(missing, k)
		}
	}
	unknown := false
	for _, rule := range rules {
		targets, ok := rule["targets"].([]any)
		if !ok {
			return nil, fail("invalid_operations_rule_request", 400)
		}
		applies := false
		for _, t := range targets {
			applies = applies || t == target
		}
		if !applies {
			continue
		}
		trace := Object{"ruleId": rule["id"], "name": rule["name"], "state": "disabled", "conditions": nil, "exceptionIds": []string{}}
		if !truth(rule, "enabled") {
			traces = append(traces, trace)
			continue
		}
		env := &conditionEnvironment{Lists: byID, HasText: hasText, Text: text, Hosts: hosts, LinkCount: count, Facts: facts, Trace: map[string]Object{}}
		state, e := env.evaluate(obj(rule, "conditions"), 0, "1")
		if e != nil {
			return nil, e
		}
		tree := env.Trace["1"]
		exceptions, ok := objects(rule["exceptions"])
		if !ok {
			return nil, fail("invalid_operations_rule_request", 400)
		}
		enabledExceptions := 0
		hitExceptions := []string{}
		account := str(input, "accountId")
		for _, exception := range exceptions {
			if !truth(exception, "enabled") {
				continue
			}
			enabledExceptions++
			ids, ok := exception["accountIds"].([]any)
			if !ok {
				return nil, fail("invalid_operations_rule_request", 400)
			}
			for _, id := range ids {
				if account != "" && id == account {
					hitExceptions = append(hitExceptions, str(exception, "id"))
					break
				}
			}
		}
		if state == "hit" {
			if len(hitExceptions) > 0 {
				state = "excepted"
			} else if enabledExceptions > 0 && account == "" {
				state = "unknown"
			}
		}
		trace["state"], trace["conditions"], trace["exceptionIds"] = state, tree, hitExceptions
		traces = append(traces, trace)
		exceptionIDs = append(exceptionIDs, hitExceptions...)
		if state == "hit" {
			matchedIDs = append(matchedIDs, str(rule, "id"))
		}
		unknown = unknown || state == "unknown"
		var visit func(Object)
		visit = func(n Object) {
			if children, ok := n["children"].([]Object); ok {
				for _, c := range children {
					visit(c)
				}
			} else if str(n, "state") == "unknown" {
				addMissing(str(n, "field"))
			}
		}
		visit(tree)
		if state == "unknown" && str(tree, "state") == "hit" {
			addMissing("accountId")
		}
	}
	outcome := "allow"
	if !enabled || len(matchedIDs) > 0 {
		outcome = "reject"
	} else if unknown {
		outcome = "unknown"
	}
	return Object{"outcome": outcome, "feature": Object{"key": feature, "enabled": enabled}, "rules": traces, "matchedRuleIds": matchedIDs, "exceptionIds": exceptionIDs, "missingFacts": missing, "sideEffects": false}, nil
}
