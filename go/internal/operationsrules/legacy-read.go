package operationsrules

import "context"

func legacyView(r Object) any {
	if r == nil {
		return nil
	}
	return Object{"key": r["policy_key"], "version": r["version"], "policy": r["policy"], "createdBy": r["created_by"], "source": r["source"], "createdAt": iso(r["created_at"])}
}
func (s *Service) LegacyGet(ctx context.Context, a Actor, key string) (Object, error) {
	if !has(Keys[:3], key) {
		return nil, fail("invalid_operations_product_request", 400)
	}
	if _, e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	r, e := s.CurrentWithin(ctx, s.Pool, key)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("operations_policy_not_initialized", 503)
	}
	rows, e := s.Pool.Query(ctx, `SELECT to_jsonb(r) FROM operations_policy_processes_v1 r WHERE endpoint=$1 AND policy_key=$2 ORDER BY component,checked_at DESC,instance_id LIMIT 100`, s.Endpoint, key)
	if e != nil {
		return nil, e
	}
	records, e := collect(rows)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, p := range records {
		items = append(items, processView(p, r["version"], s.now().Unix()))
	}
	return Object{"rule": legacyView(r), "processes": items, "checkedAt": s.now().Unix()}, nil
}
func (s *Service) LegacyList(ctx context.Context, a Actor) (Object, error) {
	if _, e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	items := []any{}
	for _, key := range Keys[:3] {
		v, e := s.LegacyGet(ctx, a, key)
		if e != nil {
			return nil, e
		}
		items = append(items, v["rule"])
	}
	return Object{"items": items, "protectedSources": []any{Object{"key": "signed-governance", "editable": false, "reason": "existing-independent-review-required"}}, "checkedAt": s.now().Unix()}, nil
}
func (s *Service) LegacyHistory(ctx context.Context, a Actor, key string, input Object) (Object, error) {
	if !has(Keys[:3], key) {
		return nil, fail("invalid_operations_product_request", 400)
	}
	if _, e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	after, limit, e := page(input, 100, 30)
	if e != nil {
		return nil, fail("invalid_operations_product_request", 400)
	}
	rows, e := s.Pool.Query(ctx, `SELECT to_jsonb(r) FROM operations_product_rules_v1 r WHERE endpoint=$1 AND policy_key=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT $4`, s.Endpoint, key, after, limit+1)
	if e != nil {
		return nil, e
	}
	records, e := collect(rows)
	if e != nil {
		return nil, e
	}
	var next any
	if len(records) > limit {
		next = formatSequence(records[limit-1]["version"])
		records = records[:limit]
	}
	items := []any{}
	for _, r := range records {
		items = append(items, legacyView(r))
	}
	return Object{"items": items, "nextAfter": next}, nil
}
