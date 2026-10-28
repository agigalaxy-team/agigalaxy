package operationsrules

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"math/big"
	"unicode/utf8"
)

func parseSample(x Object) (Object, error) {
	if !closed(x, []string{"sample"}, []string{"versionId", "policy"}) {
		return nil, invalid()
	}
	_, v := x["versionId"]
	_, p := x["policy"]
	if v == p || v && !uuidPattern.MatchString(str(x["versionId"])) {
		return nil, invalid()
	}
	f := obj(x["sample"])
	if !closed(f, nil, []string{"target", "accountTier", "subjectType", "text", "links", "attachmentCount", "fileBytes", "accountId", "quotaCategory", "used", "before", "after"}) {
		return nil, invalid()
	}
	for key, values := range map[string][]string{"target": Targets, "accountTier": {"new", "normal"}, "subjectType": {"person", "agent", "organization"}, "quotaCategory": {"task", "comment", "invitation", "post", "version", "reply", "report"}} {
		if v, exists := f[key]; exists && !has(values, str(v)) {
			return nil, invalid()
		}
	}
	for _, key := range []string{"attachmentCount", "fileBytes", "used"} {
		if v, exists := f[key]; exists && !integer(v, 0, 9007199254740991) {
			return nil, invalid()
		}
	}
	if v, exists := f["accountId"]; exists && !uuidPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	if v, exists := f["text"]; exists {
		t, ok := v.(string)
		if !ok || utf8.RuneCountInString(t) > 20000 {
			return nil, invalid()
		}
	}
	if v, exists := f["links"]; exists {
		if !array(v) || len(list(v)) > 30 {
			return nil, invalid()
		}
		for _, link := range list(v) {
			s, ok := link.(string)
			if !ok || utf8.RuneCountInString(s) > 2048 {
				return nil, invalid()
			}
		}
	}
	for _, key := range []string{"before", "after"} {
		if v, exists := f[key]; exists {
			o := obj(v)
			if !closed(o, []string{"payloadBytes", "queuedJobs", "activeExports"}, nil) {
				return nil, invalid()
			}
			for _, n := range o {
				if !integer(n, 0, 9007199254740991) {
					return nil, invalid()
				}
			}
		}
	}
	return x, nil
}
func (s *Service) Sample(ctx context.Context, a Actor, key string, input Object) (Object, error) {
	if !has(Keys, key) {
		return nil, invalid()
	}
	if _, e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	x, e := parseSample(input)
	if e != nil {
		return nil, e
	}
	var version Object
	if x["versionId"] != nil {
		version, e = s.version(ctx, s.Pool, key, x["versionId"])
		if e != nil {
			return nil, e
		}
		if version == nil {
			return nil, fail("operations_rule_version_unavailable", 404)
		}
	}
	raw := x["policy"]
	if version != nil {
		raw = version["policy"]
	}
	policy, e := ParsePolicy(key, obj(raw))
	if e != nil {
		return nil, e
	}
	facts := obj(x["sample"])
	var evaluation Object
	switch key {
	case "business-controls":
		if facts["target"] == nil {
			return nil, invalid()
		}
		evaluation, e = businessrules.EvaluateDetailed(policy, facts)
		if e != nil {
			return nil, e
		}
	case "resource-budget":
		before, after := obj(facts["before"]), obj(facts["after"])
		if before == nil || after == nil {
			evaluation = Object{"outcome": "unknown", "missingFacts": []any{"before", "after"}, "sideEffects": false}
		} else {
			p, _ := resourcebudget.ParsePolicy(policy)
			usage := func(o Object) resourcebudget.Usage {
				return resourcebudget.Usage{PayloadBytes: big.NewInt(num(o["payloadBytes"])), QueuedJobs: num(o["queuedJobs"]), ActiveExports: num(o["activeExports"])}
			}
			e := resourcebudget.EnforceResourceGrowth(usage(before), usage(after), p)
			evaluation = Object{"outcome": "allow", "sideEffects": false}
			if e != nil {
				evaluation["outcome"], evaluation["code"] = "reject", fault.Code(e)
			}
		}
	default:
		categories := []string{"task", "comment", "invitation"}
		if key == "forum-quota" {
			categories = []string{"post", "version", "reply", "report"}
		}
		missing := []any{}
		tier, category := str(facts["accountTier"]), str(facts["quotaCategory"])
		if tier == "" {
			missing = append(missing, "accountTier")
		}
		if _, ok := facts["used"]; !ok {
			missing = append(missing, "used")
		}
		if !has(categories, category) {
			missing = append(missing, "quotaCategory")
		}
		if len(missing) > 0 {
			evaluation = Object{"outcome": "unknown", "missingFacts": missing, "sideEffects": false}
		} else {
			limit, used := num(obj(policy[tier])[category]), num(facts["used"])
			remaining := max(int64(0), limit-used)
			outcome := "reject"
			if remaining > 0 {
				outcome = "allow"
			}
			evaluation = Object{"outcome": outcome, "quota": Object{"category": category, "tier": tier, "limit": limit, "used": used, "remaining": remaining}, "sideEffects": false}
		}
	}
	if _, e = s.readable(ctx, a); e != nil {
		return nil, e
	}
	var id, published any
	if version != nil {
		id, published = version["id"], version["published_version"]
	}
	return s.metadata(Object{"key": key, "versionId": id, "publishedVersion": published, "evaluation": evaluation}), nil
}

// EvaluatePublishedWithin explains a pinned published rule. Current writes
// continue to use businessrules.Service.EnforceWithin in their own transaction.
func (s *Service) EvaluatePublishedWithin(ctx context.Context, q Reader, version int64, facts Object) (Object, error) {
	if version < 1 || version > 2147483647 {
		return nil, invalid()
	}
	row, e := one(ctx, q, `SELECT to_jsonb(r) FROM operations_product_rules_v1 r WHERE endpoint=$1 AND policy_key='business-controls' AND version=$2`, s.Endpoint, version)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, fail("operations_rule_version_unavailable", 404)
	}
	policy, e := ParseControls(obj(row["policy"]))
	if e != nil {
		return nil, e
	}
	evaluation, e := businessrules.EvaluateDetailed(policy, facts)
	if e != nil {
		return nil, e
	}
	return Object{"version": version, "evaluation": evaluation}, nil
}
