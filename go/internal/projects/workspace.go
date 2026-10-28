package projects

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) management(ctx context.Context, tx pgx.Tx, viewer string, p Object) (Object, error) {
	owner := str(p, "owner_id") == viewer
	transfers, roles := []Object{}, []Object{}
	rr, e := rows(ctx, tx, "SELECT to_jsonb(t) FROM project_transfers_v2 t WHERE project_id=$1 AND state='offered' AND ($2 OR to_subject_id=$3)", p["id"], owner, nullable(viewer))
	if e != nil {
		return nil, e
	}
	for _, r := range rr {
		if r["from_subject_id"] != p["owner_id"] || str(p, "state") != "active" {
			continue
		}
		event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM project_events_v2 e WHERE operation_id=$1", r["offer_event_id"])
		if e != nil {
			return nil, e
		}
		grant, e := s.grant(ctx, tx, event)
		if unavailable(e) {
			continue
		}
		if e != nil {
			return nil, e
		}
		if !s.canRead(grant, viewer) {
			continue
		}
		transfers = append(transfers, Object{"transferId": r["id"], "fromSubjectId": r["from_subject_id"], "toSubjectId": r["to_subject_id"], "state": "offered", "operationId": r["offer_event_id"]})
	}
	if owner {
		rr, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM project_roles_v2 r WHERE project_id=$1 AND state='active' ORDER BY subject_id,role", p["id"])
		if e != nil {
			return nil, e
		}
		for _, r := range rr {
			effective, e := s.RolesWithin(ctx, tx, p, str(r, "subject_id"))
			if e != nil {
				return nil, e
			}
			if contains(effective, str(r, "role")) {
				roles = append(roles, Object{"subjectId": r["subject_id"], "role": r["role"], "grantOperationId": r["grant_event_id"]})
			}
		}
	}
	return Object{"roles": roles, "transfers": transfers}, nil
}
func (s *Service) workspace(ctx context.Context, tx pgx.Tx, viewer, id string) (Object, error) {
	p, e := s.project(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	management, e := s.management(ctx, tx, viewer, p)
	if e != nil {
		return nil, e
	}
	view, e := s.readWithin(ctx, tx, viewer, id, true, false)
	if e == nil {
		view["management"] = management
		return view, nil
	}
	offered := false
	for _, r := range management["transfers"].([]Object) {
		offered = offered || str(r, "toSubjectId") == viewer
	}
	if !unavailable(e) || !offered {
		return nil, e
	}
	return Object{"schemaVersion": 2, "projectId": id, "revision": p["revision"], "state": p["state"], "ownerId": p["owner_id"], "document": nil, "contentUnavailable": true, "ownRoles": []string{}, "permissions": Object{"edit": false, "represent": false, "manage": false}, "management": management, "transferMeaning": "pending-offer-only; original-document-access-still-required-for-acceptance"}, nil
}
func (s *Service) Get(ctx context.Context, a Actor, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, projectError()
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		viewer := ""
		if a.Device != nil {
			viewer = a.Device.SubjectID
		}
		return s.workspace(ctx, tx, viewer, id)
	})
}
func (s *Service) List(ctx context.Context, a Actor, raw []byte) (Object, error) {
	if a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil {
		return nil, projectError()
	}
	if _, ok := q["after"]; !ok {
		q["after"] = ""
	}
	if _, ok := q["limit"]; !ok {
		q["limit"] = 50
	}
	after, ok := q["after"].(string)
	if !ok || after != "" && !projectListAfter.MatchString(after) || !integer(q["limit"], 1, 100) {
		return nil, projectError()
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		limit := num(q, "limit")
		rr, e := rows(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT DISTINCT p.id FROM projects_v2 p LEFT JOIN project_roles_v2 r ON r.project_id=p.id WHERE (p.owner_id=$1 OR (r.subject_id=$1 AND r.state='active') OR EXISTS(SELECT 1 FROM project_transfers_v2 t WHERE t.project_id=p.id AND t.to_subject_id=$1 AND t.state='offered' AND t.from_subject_id=p.owner_id)) AND ($2='' OR p.id::text>$2) ORDER BY p.id LIMIT $3) q`, a.Device.SubjectID, after, limit+1)
		if e != nil {
			return nil, e
		}
		scanned := rr
		if int64(len(scanned)) > limit {
			scanned = scanned[:limit]
		}
		items := []Object{}
		for _, r := range scanned {
			view, e := s.workspace(ctx, tx, a.Device.SubjectID, str(r, "id"))
			if unavailable(e) {
				continue
			}
			if e != nil {
				return nil, e
			}
			eligible := len(view["ownRoles"].([]string)) > 0
			for _, tr := range obj(view, "management")["transfers"].([]Object) {
				eligible = eligible || str(tr, "toSubjectId") == a.Device.SubjectID
			}
			if eligible {
				items = append(items, view)
			}
		}
		var next any
		if int64(len(rr)) > limit {
			next = rr[limit-1]["id"]
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
func (s *Service) preference(ctx context.Context, tx pgx.Tx, subject, id string) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(p) FROM project_preferences_v2 p WHERE project_id=$1 AND subject_id=$2", id, subject)
	if e != nil {
		return nil, e
	}
	var settings any
	revision := int64(0)
	if r != nil {
		revision = num(r, "revision")
		if r["settings"] != nil {
			settings, e = parseWish(obj(r, "settings"))
			if e != nil {
				return nil, e
			}
		}
	}
	return Object{"projectId": id, "revision": revision, "preferences": settings}, nil
}
func (s *Service) Preferences(ctx context.Context, a Actor, id string) (Object, error) {
	if a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		if _, e := s.readWithin(ctx, tx, a.Device.SubjectID, id, false, false); e != nil {
			return nil, e
		}
		return s.preference(ctx, tx, a.Device.SubjectID, id)
	})
}
func (s *Service) SavePreferences(ctx context.Context, a Actor, id string, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "expectedRevision", "preferences") || !integer(q["expectedRevision"], 0, 9007199254740991) {
		return nil, projectError()
	}
	if _, ok := q["preferences"]; !ok {
		return nil, projectError()
	}
	if q["preferences"] != nil {
		var e error
		q["preferences"], e = parseWish(obj(q, "preferences"))
		if e != nil {
			return nil, e
		}
	}
	return s.run(ctx, a, true, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		if _, e := s.readWithin(ctx, tx, a.Device.SubjectID, id, false, false); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912359))", id+":"+a.Device.SubjectID); e != nil {
			return nil, e
		}
		current, e := s.preference(ctx, tx, a.Device.SubjectID, id)
		if e != nil {
			return nil, e
		}
		if num(current, "revision") != num(q, "expectedRevision") {
			return nil, fail("project_preference_conflict", 409)
		}
		// The original nullable value is JSONB null, never SQL NULL.
		settings := encode(q["preferences"])
		if _, e = tx.Exec(ctx, "INSERT INTO project_preferences_v2(project_id,subject_id,revision,settings,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,subject_id) DO UPDATE SET revision=$3,settings=$4,updated_at=$5", id, a.Device.SubjectID, num(current, "revision")+1, settings, time.Unix(s.now(), 0)); e != nil {
			return nil, e
		}
		return s.preference(ctx, tx, a.Device.SubjectID, id)
	})
}
