package recruitment

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Query(ctx context.Context, a Actor, raw []byte) (Object, error) {
	q, e := parseQuery(raw)
	if e != nil {
		return nil, e
	}
	if q["view"] == "managed" && a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	if s.Opportunities == nil {
		return nil, fail("recruitment_discovery_unavailable", 503)
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		viewer := ""
		if a.Device != nil {
			viewer = a.Device.SubjectID
		}
		var context Object
		if q["view"] == "discover" {
			var e error
			context, e = s.Opportunities.ContextWithin(ctx, tx, a.Device, Object{"context": q["context"], "purposes": []string{"recruitment"}})
			if e != nil {
				return nil, e
			}
		}
		hashInput := []byte(`{"kind":"recruitment","view":`)
		hashInput = append(hashInput, encode(q["view"])...)
		if c, ok := q["context"]; ok {
			hashInput = append(hashInput, []byte(`,"context":`)...)
			hashInput = append(hashInput, orderedContext(c.(map[string]any))...)
		}
		hashInput = append(hashInput, []byte(`,"limit":`)...)
		hashInput = append(hashInput, encode(q["limit"])...)
		hash := identity.Digest(append(hashInput, '}'))
		var start any
		if after := str(q, "after"); after != "" {
			cursor, e := s.Opportunities.OpenCursor(after, hash, viewer)
			if e != nil {
				return nil, e
			}
			start = cursor["startAfter"]
		}
		limit := int(num(q, "limit"))
		rr, e := rows(ctx, tx, `SELECT to_jsonb(o) FROM recruitment_opportunities o WHERE ($1::uuid IS NULL OR o.id>$1) AND ($2='discover' AND o.state='active' AND o.expires_at>$3 OR $2='managed' AND EXISTS(SELECT 1 FROM projects_v2 p WHERE p.id=o.project_id AND (p.owner_id=$4 OR EXISTS(SELECT 1 FROM project_roles_v2 r WHERE r.project_id=p.id AND r.subject_id=$4 AND r.role='representative' AND r.state='active')))) ORDER BY o.id LIMIT $5`, start, q["view"], stamp(s.now()), nullable(viewer), limit+1)
		if e != nil {
			return nil, e
		}
		scanned := len(rr)
		if scanned > limit {
			scanned = limit
		}
		items := []Object{}
		for _, r := range rr[:scanned] {
			if q["view"] == "discover" {
				item, e := s.opportunityWithin(ctx, tx, a.Device, viewer, r, context)
				if e != nil {
					return nil, e
				}
				if item != nil {
					items = append(items, item)
				}
			} else {
				_, e := s.Projects.RequireRoleWithin(ctx, tx, *a.Device, str(r, "project_id"), []string{"owner", "representative"}, false)
				if e != nil {
					if unavailable(e) {
						continue
					}
					return nil, e
				}
				v, e := s.readWithin(ctx, tx, a.Device, viewer, str(r, "id"), false)
				if e != nil {
					if !unavailable(e) {
						return nil, e
					}
					v = s.receipt(r)
					v["contentUnavailable"] = true
				}
				items = append(items, v)
			}
		}
		var after any
		if len(rr) > limit {
			after, e = s.Opportunities.SealCursor(Object{"v": 2, "queryHash": hash, "viewerId": nullable(viewer), "startAfter": rr[limit-1]["id"]})
			if e != nil {
				return nil, e
			}
		}
		return Object{"items": items, "nextAfter": after, "scanned": scanned, "globalCountProvided": false, "currentSourceRechecked": true, "interpretation": "user-side-model-or-user", "taskAutomaticallyCreated": false}, nil
	})
}

// Query context is a strict original schema: its key order is stable after
// parsing, and feeds the original transient cursor's JSON.stringify hash.
func orderedContext(x Object) []byte {
	keys := []string{"kind", "projectId"}
	if x["kind"] == "ephemeral" {
		keys = []string{"kind", "title", "functions", "technologies"}
	}
	b := []byte{'{'}
	for _, k := range keys {
		if len(b) > 1 {
			b = append(b, ',')
		}
		b = append(b, encode(k)...)
		b = append(b, ':')
		b = append(b, encode(x[k])...)
	}
	return append(b, '}')
}
