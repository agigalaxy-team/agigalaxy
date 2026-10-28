package builders

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) managementWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	b, e := s.load(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	if b.parent["owner_id"] != a.SubjectID {
		return nil, fault.New("builder_unavailable", 404)
	}
	declaration, g, e := s.current(ctx, tx, &a, b)
	if e != nil && !domainError(e) {
		return nil, e
	}
	actions := []string{"declare", "delist", "correction", "security-issue"}
	state := "unavailable"
	if declaration != nil {
		state = "readable"
		actions = []string{"declare", "delist", "relist", "correction", "security-issue", "resolve-security"}
	}
	out := maintenance(b.rows)
	for k, v := range (Object{"mode": "owner-management", "builderId": b.parent["id"], "ownerId": b.parent["owner_id"], "type": b.parent["type"], "revision": b.parent["revision"], "declarationId": nullable(b.declaration["id"]), "declarationHash": nullable(b.declaration["payload_hash"]), "declaration": nullable(declaration), "declarationState": state, "capabilityVerified": false, "allowedActions": actions}) {
		out[k] = v
	}
	if declaration != nil {
		out["disclosure"] = Object{"visibility": g.Visibility, "viewers": g.Viewers}
	}
	return out, nil
}
func (s *Service) Manage(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("builderReadSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.managementWithin(ctx, tx, a, txt(input, "builderId"))
	})
}
func (s *Service) Owned(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("builderOwnedQuerySchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		limit := int(num(input, "limit"))
		rows, e := query(ctx, tx, "SELECT id::text FROM builders WHERE owner_id=$1 AND ($2::text IS NULL OR type=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", a.SubjectID, input["type"], input["after"], limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for i, row := range rows {
			if i >= limit {
				break
			}
			item, e := s.managementWithin(ctx, tx, a, txt(row, "id"))
			if e != nil {
				return nil, e
			}
			items = append(items, Object{"builderId": item["builderId"], "type": item["type"], "revision": item["revision"], "name": nullable(obj(item["declaration"])["name"]), "declarationState": item["declarationState"], "delisted": item["delisted"], "securityIssue": item["securityIssue"]})
		}
		var after any
		if len(rows) > limit {
			after = obj(items[len(items)-1])["builderId"]
		}
		return Object{"items": items, "nextAfter": after, "scope": "current-owner", "automaticEndpointProbes": false}, nil
	})
}
func (s *Service) Notices(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("builderNoticesSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		b, e := s.load(ctx, tx, txt(input, "builderId"), false)
		if e != nil {
			return nil, e
		}
		items := []any{}
		limit := int(num(input, "limit"))
		for _, row := range b.rows {
			if row["kind"] != "maintenance" || num(row, "revision") <= num(input, "after") {
				continue
			}
			allowed, e := s.permitted(ctx, tx, a, row)
			if e != nil {
				return nil, e
			}
			if !allowed {
				continue
			}
			event := event(row)
			items = append(items, Object{"eventId": row["id"], "declarationId": event["declarationId"], "revision": row["revision"], "action": event["action"], "summary": event["summary"], "receivedAt": row["received_at"]})
			if len(items) > limit {
				break
			}
		}
		if len(items) == 0 && (a == nil || a.SubjectID != txt(b.parent, "owner_id")) {
			if _, _, e = s.current(ctx, tx, a, b); e != nil {
				return nil, e
			}
		}
		var after any
		if len(items) > limit {
			items = items[:limit]
			after = obj(items[len(items)-1])["revision"]
		}
		return Object{"builderId": input["builderId"], "items": items, "nextAfter": after, "scope": "currently-visible-maintenance-history", "declarationIncluded": false, "capabilityVerified": false}, nil
	})
}
