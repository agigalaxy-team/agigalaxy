package operationsstrategies

import "context"

// VersionRehearsals returns bounded historical facts owned by this person. It
// does not assess current publication eligibility or rerun a rehearsal.
func (s *Service) VersionRehearsals(ctx context.Context, a Actor, versionID string, filters Object) (Object, error) {
	if !uuidPattern.MatchString(versionID) || !closed(filters, nil, []string{"after", "limit"}) {
		return nil, invalid()
	}
	limit := int64(20)
	if v, ok := filters["limit"]; ok {
		if !integer(v, 1, 50) {
			return nil, invalid()
		}
		limit = num(v)
	}
	after := str(filters["after"])
	if after != "" && !uuidPattern.MatchString(after) {
		return nil, invalid()
	}
	actor, e := s.current(ctx, a, "strategies.read")
	if e != nil {
		return nil, e
	}
	if after != "" {
		anchor, err := one(ctx, s.Pool, `SELECT to_jsonb(r) FROM (SELECT id FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND version_id=$2 AND operator_id=$3 AND id=$4) r`, s.Endpoint, versionID, actor.ID, after)
		if err != nil {
			return nil, err
		}
		if anchor == nil {
			return nil, invalid()
		}
	}
	var cursor any
	if after != "" {
		cursor = after
	}
	rows, e := many(ctx, s.Pool, `SELECT to_jsonb(r) FROM (SELECT id,version_id,execution_ids,created_at FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND version_id=$2 AND operator_id=$3 AND ($4::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND version_id=$2 AND operator_id=$3 AND id=$4)) ORDER BY created_at DESC,id DESC LIMIT $5) r`, s.Endpoint, versionID, actor.ID, cursor, limit+1)
	if e != nil {
		return nil, e
	}
	hasMore := len(rows) > int(limit)
	if hasMore {
		rows = rows[:limit]
	}
	items := []any{}
	availability := "available"
	for _, row := range rows {
		id := str(row["id"])
		original, err := s.RehearsalOperation(ctx, a, id)
		if err != nil {
			return nil, err
		}
		if original["state"] != "recorded" || original["versionId"] != versionID || !same(original["executionIds"], row["execution_ids"]) {
			availability = "partial"
			continue
		}
		result := obj(original["result"])
		var valid any
		itemAvailability := "unknown"
		if b, ok := result["valid"].(bool); ok && result["versionId"] == versionID && result["rehearsalId"] == id {
			valid, itemAvailability = b, "available"
		} else {
			availability = "partial"
		}
		items = append(items, Object{"rehearsalId": id, "versionId": versionID, "executionIds": original["executionIds"], "valid": valid, "createdAt": iso(row["created_at"]), "availability": itemAvailability, "basis": "historical-original-domain-rehearsal", "currentPublishEligibility": "not-checked"})
	}
	if _, e = s.current(ctx, a, "strategies.read"); e != nil {
		return nil, e
	}
	var next any
	if hasMore && len(rows) > 0 {
		next = rows[len(rows)-1]["id"]
	}
	return Object{"items": items, "hasMore": hasMore, "nextAfter": next, "availability": availability, "scope": "same-owner-exact-version"}, nil
}
