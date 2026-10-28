package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"strings"
)

func (s *Service) sectionView(ctx context.Context, tx pgx.Tx, r Object, account string) (Object, error) {
	participate, e := s.sectionAllowed(ctx, tx, account, r, true)
	if e != nil {
		return nil, e
	}
	return Object{"sectionId": r["id"], "title": r["title"], "theme": r["theme"], "description": r["description"], "maintainerAccountId": r["maintainer_account_id"], "creatorSubjectId": r["creator_subject_id"], "version": r["version"], "state": r["state"], "category": r["category"], "audience": r["audience"], "canMaintain": account != "" && account == str(r, "maintainer_account_id"), "createdAt": seconds(r["created_at"]), "updatedAt": seconds(r["updated_at"]), "checkedAt": s.clock(), "canParticipate": participate}, nil
}
func (s *Service) GetSection(ctx context.Context, account, id string) (Object, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		r, e := s.section(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		account, e = s.viewerForRow(ctx, tx, account, r)
		if e != nil {
			return nil, e
		}
		ok, e := s.sectionAllowed(ctx, tx, account, r, false)
		if e != nil {
			return nil, e
		}
		if !ok {
			return nil, fail("not_found", 404)
		}
		return s.sectionView(ctx, tx, r, account)
	})
}
func (s *Service) Sections(ctx context.Context, account string, raw []byte) (Object, error) {
	q, limit, e := queryInput(raw, "after", "limit", "managed")
	if e != nil {
		return nil, e
	}
	if v, ok := q["after"]; ok && !validID(asString(v)) {
		return nil, invalid()
	}
	if v, ok := q["managed"]; ok {
		if _, ok = v.(bool); !ok {
			return nil, invalid()
		}
	}
	managed := truth(q, "managed")
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		if managed && account == "" && s.actor == nil {
			return nil, fail("access_denied", 401)
		}
		ids := []string{}
		if account != "" {
			ids = append(ids, account)
		} else if s.actor != nil {
			available, e := s.availableIdentityAccounts(ctx, tx)
			if e != nil {
				return nil, e
			}
			for _, a := range available {
				ids = append(ids, str(a, "id"))
			}
		}
		rr, e := rows(ctx, tx, "SELECT to_jsonb(s) FROM forum_sections_v2 s WHERE ($1::uuid IS NULL OR id>$1) AND (NOT $2::boolean OR maintainer_account_id=ANY($3::uuid[])) ORDER BY id LIMIT 201", q["after"], managed, ids)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var scanned any
		processed := 0
		for _, r := range rr {
			if processed == 200 {
				break
			}
			processed++
			scanned = r["id"]
			viewer, e := s.viewerForRow(ctx, tx, account, r)
			if e != nil {
				return nil, e
			}
			ok, e := s.sectionAllowed(ctx, tx, viewer, r, false)
			if e != nil {
				return nil, e
			}
			if ok {
				view, e := s.sectionView(ctx, tx, r, viewer)
				if e != nil {
					return nil, e
				}
				items = append(items, view)
			}
			if int64(len(items)) == limit {
				break
			}
		}
		more := processed < len(rr)
		var next any
		if more {
			next = scanned
		}
		return Object{"items": items, "nextAfter": next, "scanTruncated": more && processed == 200 && int64(len(items)) < limit, "checkedAt": s.clock()}, nil
	})
}
func (s *Service) SaveSection(ctx context.Context, account, raw string) (Object, error) {
	if len(raw) > int(num(s.policy(), "maxPayloadBytes")) {
		return nil, fail("forum_payload_too_large", 413)
	}
	var p Object
	if protocol.Decode([]byte(raw), &p) != nil || p == nil || !strict(p, "schemaVersion", "operationId", "accountId", "sectionId", "expectedVersion", "title", "theme", "description", "audience", "state") || !integer(p["schemaVersion"], 1, 1) || !validID(str(p, "operationId")) || !validID(str(p, "sectionId")) || !integer(p["expectedVersion"], 0, 9007199254740991) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if v, ok := p["accountId"]; ok && !validID(asString(v)) {
		return nil, fail("invalid_forum_payload", 400)
	}
	for key, max := range map[string]int{"title": 120, "theme": 400, "description": 4000} {
		v, ok := p[key].(string)
		if !ok {
			return nil, fail("invalid_forum_payload", 400)
		}
		v = strings.TrimSpace(v)
		if len([]rune(v)) > max || key != "description" && v == "" {
			return nil, fail("invalid_forum_payload", 400)
		}
		p[key] = v
	}
	if !validAudience(obj(p, "audience")) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if v, ok := p["state"]; ok && v != "active" && v != "archived" {
		return nil, fail("invalid_forum_payload", 400)
	}
	account, e := s.writeTarget(account, p)
	if e != nil {
		return nil, e
	}
	return s.runWrite(ctx, account, false, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912318,hashtext($1))", p["operationId"]); e != nil {
			return nil, e
		}
		prior, e := s.prior(ctx, tx, account, str(p, "operationId"), raw)
		if e != nil || prior != nil {
			return prior, e
		}
		kind := "update"
		if num(p, "expectedVersion") == 0 {
			kind = "create"
			if str(p, "sectionId") != deriveID("section", "create-section", s.actorKey(account), p, "sectionId") {
				return nil, fail("forum_locator_mismatch", 409)
			}
		}
		if s.actor != nil {
			if kind == "update" {
				source, e := s.section(ctx, tx, str(p, "sectionId"))
				if e != nil {
					return nil, e
				}
				if source == nil {
					return nil, fail("not_found", 404)
				}
				if account != "" && account != str(source, "maintainer_account_id") {
					return nil, fail("not_found", 404)
				}
				account = str(source, "maintainer_account_id")
			}
			selected, e := s.resolveIdentityAccount(ctx, tx, account, true)
			if e != nil {
				return nil, e
			}
			account = str(selected, "id")
		}
		if _, e = s.writeAccount(ctx, tx, account, false); e != nil {
			return nil, e
		}
		before, e := s.usage(ctx, tx, account)
		if e != nil {
			return nil, e
		}
		current, e := row(ctx, tx, "SELECT to_jsonb(s) FROM forum_sections_v2 s WHERE id=$1 FOR UPDATE", p["sectionId"])
		if e != nil {
			return nil, e
		}
		if kind == "create" && current != nil {
			return nil, fail("forum_section_conflict", 409)
		}
		if kind == "update" && (current == nil || str(current, "maintainer_account_id") != account) {
			return nil, fail("not_found", 404)
		}
		if num(current, "version") != num(p, "expectedVersion") {
			return nil, fail("forum_section_version_conflict", 409)
		}
		if _, e = s.publication(ctx, tx, account, Object{"audience": p["audience"]}, nil); e != nil {
			return nil, e
		}
		if e = s.authorizeIdentityAction(ctx, tx, raw, "forum.section.write", str(p, "sectionId")); e != nil {
			return nil, e
		}
		state := str(p, "state")
		if state == "" {
			state = str(current, "state")
			if state == "" {
				state = "active"
			}
		}
		version := num(p, "expectedVersion") + 1
		if current == nil {
			_, e = tx.Exec(ctx, `INSERT INTO forum_sections_v2(id,maintainer_account_id,creator_subject_id,version,title,theme,description,audience,state,created_at,updated_at) VALUES($1,$2,$9,1,$3,$4,$5,$6,$7,$8,$8)`, p["sectionId"], account, p["title"], p["theme"], p["description"], encode(p["audience"]), state, s.now(), s.subject())
		} else {
			_, e = tx.Exec(ctx, "UPDATE forum_sections_v2 SET version=$2,title=$3,theme=$4,description=$5,audience=$6,state=$7,updated_at=$8 WHERE id=$1", p["sectionId"], version, p["title"], p["theme"], p["description"], encode(p["audience"]), state, s.now())
		}
		if e != nil {
			return nil, e
		}
		result := Object{"acknowledged": true, "sectionId": p["sectionId"], "version": version, "accountId": account, "subjectId": s.subject(), "authority": "accepted-operation-only"}
		_, e = tx.Exec(ctx, `INSERT INTO forum_section_events_v2(id,section_id,account_id,subject_id,actor_kind,kind,version,consent_id,payload_text,payload_hash,result,http_request_id,created_at) VALUES($1,$2,$3,$11,$12,$4,$5,$13,$6,$7,$8,$9,$10)`, p["operationId"], p["sectionId"], account, kind, version, raw, identity.Digest([]byte(raw)), encode(result), null(s.RequestID), s.now(), s.subject(), s.actorKind(), s.consentID())
		if e != nil {
			return nil, e
		}
		if e = s.complete(ctx, tx, account, raw, "", p, Object{"kind": "section", "sectionId": p["sectionId"]}, result); e != nil {
			return nil, e
		}
		after, e := s.usage(ctx, tx, account)
		if e != nil {
			return nil, e
		}
		if after > num(s.policy(), "accountForumMaxBytes") && after > before {
			return nil, fail("forum_storage_quota_exceeded", 409)
		}
		return result, nil
	})
}
