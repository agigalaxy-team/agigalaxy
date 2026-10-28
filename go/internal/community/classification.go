package community

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ClassifySection(ctx context.Context, id, raw string) (Object, error) {
	if len(raw) > int(num(s.policy(), "maxPayloadBytes")) {
		return nil, fail("forum_payload_too_large", 413)
	}
	var p Object
	if protocol.Decode([]byte(raw), &p) != nil || !strict(p, "schemaVersion", "operationId", "sectionId", "expectedVersion", "category") || !integer(p["schemaVersion"], 1, 1) || !validID(str(p, "operationId")) || !validID(str(p, "sectionId")) || !integer(p["expectedVersion"], 0, 9007199254740991) || !topic(str(p, "category"), true) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if id != str(p, "sectionId") {
		return nil, fail("forum_event_route_mismatch", 400)
	}
	if s.actor == nil || !hasString(s.ModeratorIDs, s.actor.actor.SubjectID) {
		return nil, fail("access_denied", 403)
	}
	s.actor.scope = "moderation"
	return s.runWrite(ctx, "", false, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912318,hashtext($1))", p["operationId"]); e != nil {
			return nil, e
		}
		prior, e := s.prior(ctx, tx, "", str(p, "operationId"), raw)
		if e != nil || prior != nil {
			return prior, e
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(s) FROM forum_sections_v2 s WHERE id=$1 FOR UPDATE", id)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, fail("not_found", 404)
		}
		if num(r, "version") != num(p, "expectedVersion") {
			return nil, fail("forum_section_version_conflict", 409)
		}
		if e = s.authorizeIdentityAction(ctx, tx, raw, "forum.section.classify", id); e != nil {
			return nil, e
		}
		version := num(r, "version") + 1
		_, e = tx.Exec(ctx, "UPDATE forum_sections_v2 SET category=$2,version=$3,updated_at=$4 WHERE id=$1", id, p["category"], version, s.now())
		if e != nil {
			return nil, e
		}
		result := Object{"acknowledged": true, "sectionId": id, "version": version, "category": p["category"], "subjectId": s.subject(), "authority": "accepted-operation-only"}
		_, e = tx.Exec(ctx, `INSERT INTO forum_section_events_v2(id,section_id,account_id,subject_id,actor_kind,kind,version,consent_id,payload_text,payload_hash,result,http_request_id,created_at) VALUES($1,$2,NULL,$3,'identity','classification',$4,$5,$6,$7,$8,$9,$10)`, p["operationId"], id, s.subject(), version, s.consentID(), raw, identity.Digest([]byte(raw)), encode(result), null(s.RequestID), s.now())
		if e != nil {
			return nil, e
		}
		s.actor.action = "forum.section.classify"
		if e = s.complete(ctx, tx, "", raw, "", p, Object{"kind": "section", "sectionId": id}, result); e != nil {
			return nil, e
		}
		return result, nil
	})
}
