package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) sectionWithin(ctx context.Context, tx pgx.Tx, id string, lock bool) (Object, error) {
	if !validID(id) {
		return nil, invalid()
	}
	clause := " FOR SHARE"
	if lock {
		clause = " FOR UPDATE"
	}
	x, e := one(ctx, tx, "SELECT to_jsonb(s) FROM forum_sections_v2 s WHERE id=$1"+clause, id)
	if e == nil && x == nil {
		e = fail("not_found", 404)
	}
	return x, e
}
func (s *Service) visibility(ctx context.Context, tx pgx.Tx, kind, id string) (Object, error) {
	return businessadmin.VisibilityWithin(ctx, tx, s.Endpoint, kind, id, s.now())
}
func (s *Service) sectionView(ctx context.Context, tx pgx.Tx, r Object, a Actor) (Object, error) {
	read, e := s.Forum.OperationsSectionReadableWithin(ctx, tx, r)
	if e != nil {
		return nil, e
	}
	owner, e := one(ctx, tx, "SELECT jsonb_build_object('uid',a.uid,'display_name',p.display_name) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2", r["maintainer_account_id"], s.Endpoint)
	if e != nil {
		return nil, e
	}
	v, e := s.visibility(ctx, tx, "forum-section", str(r, "id"))
	if e != nil {
		return nil, e
	}
	out := Object{"id": r["id"], "version": r["version"], "state": r["state"], "category": r["category"], "title": nil, "theme": nil, "description": nil, "sourceState": "restricted", "maintainerAccountId": r["maintainer_account_id"], "maintainerDisplayName": owner["display_name"], "maintainerUid": owner["uid"], "creatorId": r["creator_subject_id"], "visibility": v, "canHide": permitted(a, "sections.hide") && !yes(v, "hidden"), "canRestore": permitted(a, "sections.restore") && yes(v, "hidden"), "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]), "canManage": permitted(a, "sections.classify"), "maxHideSeconds": s.policy()["maxGovernanceHideSeconds"], "checkedAt": s.now()}
	if read {
		out["title"], out["theme"], out["description"], out["sourceState"] = r["title"], r["theme"], r["description"], "available"
	}
	return out, nil
}
func (s *Service) Sections(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parsePage(input, "sections")
	if e != nil {
		return nil, e
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	return s.domain().Run(ctx, a, "community-sections-query", q, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := rows(ctx, tx, "SELECT to_jsonb(s) FROM forum_sections_v2 s WHERE ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR state=$2) AND ($3::text IS NULL OR category=$3) ORDER BY id LIMIT $4", q["after"], q["state"], q["category"], num(q, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var next any
		for i, x := range r {
			if int64(i) == num(q, "limit") {
				next = r[i-1]["id"]
				break
			}
			v, e := s.sectionView(ctx, tx, x, a)
			if e != nil {
				return nil, e
			}
			items = append(items, v)
		}
		catalog := s.Forum.Topics()
		cats := append([]Object{}, catalog["items"].([]Object)...)
		cats = append(cats, catalog["unclassified"].(Object))
		return Object{"items": items, "nextAfter": next, "categories": cats, "checkedAt": s.now()}, nil
	})
}
func (s *Service) Section(ctx context.Context, a Actor, id string) (Object, error) {
	if e := s.ready(); e != nil {
		return nil, e
	}
	return s.domain().Run(ctx, a, "community-section-read", Object{"id": id}, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.sectionWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		return s.sectionView(ctx, tx, r, a)
	})
}
func (s *Service) Classify(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	x, e := parseWrite(input, "classify")
	if e != nil || !validID(id) {
		return nil, invalid()
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	selection := copyObject(x)
	selection["id"] = id
	return s.domain().Command(ctx, a, "community-section-classify", selection, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.sectionWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if num(r, "version") != num(x, "expectedVersion") {
			return nil, fail("forum_section_version_conflict", 409)
		}
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM forum_section_events_v2 WHERE id=$1)", x["operationId"]).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fail("business_admin_operation_conflict", 409)
		}
		version := num(r, "version") + 1
		result := Object{"sectionId": id, "version": version, "category": x["category"], "actorKind": actorKind(s, a), "operatorId": a.ID}
		p := protocol.NewOrderedObject()
		p.Set("sectionId", id)
		for _, key := range []string{"operationId", "expectedVersion", "category", "reason"} {
			p.Set(key, x[key])
		}
		raw, e := protocol.EncodeJS(p)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE forum_sections_v2 SET category=$2,version=$3,updated_at=$4 WHERE id=$1", id, x["category"], version, stamp(s.now())); e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO forum_section_events_v2(id,section_id,account_id,subject_id,actor_kind,operator_id,kind,version,consent_id,payload_text,payload_hash,result,http_request_id,created_at) VALUES($1,$2,NULL,NULL,$10,$3,'classification',$4,NULL,$5,$6,$7,$8,$9)`, x["operationId"], id, a.ID, version, string(raw), digest(string(raw)), encode(result), a.RequestID, stamp(s.now()), actorKind(s, a))
		return result, e
	})
}
func (s *Service) SectionVisibility(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	x, e := parseWrite(input, "visibility")
	if e != nil || !validID(id) {
		return nil, invalid()
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	selection := copyObject(x)
	selection["id"] = id
	return s.domain().Command(ctx, a, "community-section-visibility", selection, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.sectionWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		return s.changeVisibility(ctx, tx, "forum-section", id, num(r, "version"), x)
	})
}
func (s *Service) changeVisibility(ctx context.Context, tx pgx.Tx, kind, id string, version int64, x Object) (Object, error) {
	return s.domain().ChangeVisibilityWithin(ctx, tx, kind, id, num(x, "expectedVersion"), version, x, num(s.policy(), "maxGovernanceHideSeconds"))
}
