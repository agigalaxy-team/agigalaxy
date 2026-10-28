package honor

import (
	"context"

	"github.com/jackc/pgx/v5"
)

func (s *Service) List(ctx context.Context) (Object, error) {
	if !s.registryEnabled {
		rules := []any{}
		for _, r := range s.rules {
			rules = append(rules, s.publicRule(r, false))
		}
		return Object{"issuer": s.Endpoint, "rules": rules, "checkedAt": s.now(), "ruleHistorySupported": false}, nil
	}
	return s.read(ctx, nil, false, func(tx pgx.Tx) (Object, error) {
		state, e := CurrentRegistryWithin(ctx, tx, s.Endpoint)
		if e != nil {
			return nil, e
		}
		rules := []any{}
		for _, v := range array(state["rules"]) {
			ref := object(v)
			selected, e := s.selectRule(ctx, tx, str(ref, "ruleId"), str(ref, "ruleVersion"), state, nil)
			if e != nil {
				return nil, e
			}
			rule := s.publicRule(selected.Rule, false)
			rule.Set("registry", selected.Registry)
			rules = append(rules, rule)
		}
		return Object{"issuer": s.Endpoint, "rules": rules, "checkedAt": s.now(), "ruleHistorySupported": true, "configurationEventId": state["configurationEventId"]}, nil
	})
}
func (s *Service) RuleHistory(ctx context.Context, input Object) (Object, error) {
	if !closed(input, nil, []string{"ruleId", "after", "limit"}) {
		return nil, fail("invalid_honor_history_query", 400)
	}
	var id any
	if v, ok := input["ruleId"]; ok {
		if !ruleIDPattern.MatchString(text(v)) {
			return nil, fail("invalid_honor_history_query", 400)
		}
		id = v
	}
	after := int64(0)
	if v, ok := input["after"]; ok {
		if !integer(v, 0, 9007199254740991) {
			return nil, fail("invalid_honor_history_query", 400)
		}
		after = number(v)
	}
	limit := int64(8)
	if v, ok := input["limit"]; ok {
		if !integer(v, 1, 20) {
			return nil, fail("invalid_honor_history_query", 400)
		}
		limit = number(v)
	}
	if !s.registryEnabled {
		return nil, fail("honor_registry_unavailable", 503)
	}
	return s.read(ctx, nil, false, func(tx pgx.Tx) (Object, error) {
		state, e := CurrentRegistryWithin(ctx, tx, s.Endpoint)
		if e != nil {
			return nil, e
		}
		records, e := rows(ctx, tx, "SELECT to_jsonb(v) FROM honor_rule_versions v JOIN runtime_config_events c ON c.id=v.introduced_config_id WHERE v.endpoint=$1 AND v.sequence>$2 AND ($3::text IS NULL OR v.rule_id=$3) AND c.sequence<=$4 ORDER BY v.sequence LIMIT $5", s.Endpoint, after, id, state["sequence"], limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, r := range records[:min(len(records), int(limit))] {
			selected, e := s.selectRule(ctx, tx, str(r, "rule_id"), str(r, "rule_version"), state, r)
			if e != nil {
				return nil, e
			}
			items = append(items, Object{"sequence": r["sequence"], "rule": s.publicRule(selected.Rule, false), "registry": selected.Registry})
		}
		var next any
		if int64(len(records)) > limit {
			next = object(items[len(items)-1])["sequence"]
		}
		return Object{"issuer": s.Endpoint, "items": items, "nextAfter": next, "configurationEventId": state["configurationEventId"], "checkedAt": s.now(), "capabilityVerified": false}, nil
	})
}
