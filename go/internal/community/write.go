package community

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"strings"
	"time"
)

func faultCode(e error) string { return fault.Code(e) }
func (s *Service) prior(ctx context.Context, tx pgx.Tx, account, op, raw string) (Object, error) {
	r, e := row(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT subject_id,account_id,payload_hash,result,locator FROM forum_write_receipts_v1 WHERE operation_id=$1 UNION ALL SELECT subject_id,account_id,payload_hash,result,NULL::jsonb locator FROM forum_events_v1 WHERE id=$1 UNION ALL SELECT subject_id,account_id,payload_hash,result,NULL::jsonb locator FROM forum_governance_events_v1 WHERE operation_id=$1 UNION ALL SELECT subject_id,account_id,payload_hash,result,NULL::jsonb locator FROM forum_section_events_v2 WHERE id=$1 LIMIT 1)r`, op)
	if e != nil || r == nil {
		return nil, e
	}
	owns := str(r, "account_id") == account
	if s.actor != nil {
		owns = str(r, "subject_id") == s.actor.actor.SubjectID && (r["account_id"] == nil || account == "" || account == str(r, "account_id"))
	}
	if !owns || str(r, "payload_hash") != identity.Digest([]byte(raw)) {
		return nil, fail("forum_operation_conflict", 409)
	}
	out := clone(obj(r, "result"))
	out["acknowledged"] = true
	out["authority"] = "accepted-operation-only"
	return out, nil
}
func (s *Service) capture(ctx context.Context, tx pgx.Tx, account, raw, action, objectID, op string, until int64) (string, error) {
	if s.actor != nil {
		id, _, e := s.captureIdentity(ctx, tx, account, raw, action, objectID, op, until, "Public", nil, nil, nil, nil)
		return id, e
	}
	if until == 0 {
		n := num(s.policy(), "maxPermissionSeconds")
		if n > 3600 {
			n = 3600
		}
		until = s.clock() + n
	}
	if until <= s.clock() || until > s.clock()+num(s.policy(), "maxPermissionSeconds") {
		return "", fail("forum_permission_expiry", 403)
	}
	var p Object
	_ = json.Unmarshal([]byte(raw), &p)
	fields := []string{}
	for k := range p {
		fields = append(fields, k)
	}
	id := uuid.NewString()
	_, e := tx.Exec(ctx, `INSERT INTO forum_permissions_v1(id,account_id,event_id,authorization_kind,payload_hash,action,object_id,visibility,fields,viewers,issued_at,published_until,accepted_at,authorization_audit_until,policy_hash,account_viewers) VALUES($1,$2,$3,'official-account',$4,$5,$6,'Public',$7,'[]',$8,$9,$8,$10,$11,'[]')`, id, account, op, identity.Digest([]byte(raw)), action, objectID, encode(fields), s.now(), time.Unix(until, 0), time.Unix(until+num(s.policy(), "auditDays")*86400, 0), s.policyHash())
	return id, e
}
func (s *Service) event(ctx context.Context, tx pgx.Tx, account, kind, raw string, p, result Object) error {
	_, e := tx.Exec(ctx, `INSERT INTO forum_events_v1(id,subject_id,account_id,kind,post_id,version_id,reply_id,consent_id,payload_text,payload_hash,result,created_at,actor_kind,http_request_id) VALUES($1,$12,$2,$3,$4,$5,$6,$13,$7,$8,$9,$10,$14,$11)`, p["operationId"], null(account), kind, p["postId"], p["versionId"], p["replyId"], raw, identity.Digest([]byte(raw)), encode(result), s.now(), null(s.RequestID), s.subject(), s.consentID(), s.actorKind())
	return e
}
func (s *Service) complete(ctx context.Context, tx pgx.Tx, account, raw, category string, p, locator, result Object) error {
	_, e := tx.Exec(ctx, `INSERT INTO forum_write_receipts_v1(operation_id,subject_id,account_id,category,payload_hash,consent_id,locator,result,created_at,retained_until,actor_kind) VALUES($1,$9,$2,$3,$4,$10,$5,$6,$7,$8,$11)`, p["operationId"], null(account), null(category), identity.Digest([]byte(raw)), encode(locator), encode(result), s.now(), s.now().Add(time.Duration(num(s.policy(), "auditDays"))*24*time.Hour), s.subject(), s.consentID(), s.actorKind())
	if e != nil || s.actor == nil {
		return e
	}
	action := "forum.withdraw"
	switch category {
	case "post", "version":
		action = "forum.post.publish"
	case "reply":
		action = "forum.reply.publish"
	case "report":
		action = "forum.report.publish"
	}
	if str(locator, "kind") == "section" {
		action = "forum.section.write"
	}
	if s.actor.action != "" {
		action = s.actor.action
	}
	return s.auditIdentity(ctx, tx, str(p, "operationId"), asString(s.consentID()), action)
}

// Publish accepts the original payloadJson bytes; replays compare those bytes'
// hash, not a re-encoded object. ForIdentity supplies the separately authenticated
// identity/consent context; the default path retains official-account authority.
func (s *Service) Publish(ctx context.Context, account, raw string) (Object, error) {
	var probe Object
	if json.Unmarshal([]byte(raw), &probe) != nil {
		return nil, fail("invalid_forum_payload", 400)
	}
	kind := "publish-version"
	if num(probe, "expectedHeadVersion") == 0 {
		kind = "create-post"
	}
	return s.write(ctx, account, kind, raw)
}
func (s *Service) CreateReply(ctx context.Context, account, raw string) (Object, error) {
	return s.write(ctx, account, "create-reply", raw)
}
func (s *Service) Withdraw(ctx context.Context, account, kind, raw string) (Object, error) {
	if kind != "withdraw-post" && kind != "withdraw-version" && kind != "withdraw-reply" {
		return nil, fail("invalid_forum_action", 400)
	}
	return s.write(ctx, account, kind, raw)
}
func (s *Service) write(ctx context.Context, account, kind, raw string) (Object, error) {
	p, e := s.parse(kind, raw)
	if e != nil {
		return nil, e
	}
	if str(p, "accountId") != "" && str(p, "accountId") != account {
		if s.actor == nil {
			return nil, fail("official_account_changed", 409)
		}
		if account != "" {
			return nil, fail("forum_account_target_mismatch", 409)
		}
		account = str(p, "accountId")
	}
	out, e := s.runWrite(ctx, account, strings.HasPrefix(kind, "withdraw-"), func(tx pgx.Tx) (Object, error) {
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
		control := strings.HasPrefix(kind, "withdraw-")
		if s.actor != nil {
			account, e = s.selectIdentityWrite(ctx, tx, account, kind, p)
			if e != nil {
				return nil, e
			}
		}
		var owner Object
		if account != "" {
			owner, e = s.writeAccount(ctx, tx, account, control)
		}
		if e != nil {
			return nil, e
		}
		if control {
			return s.withdraw(ctx, tx, account, kind, raw, p)
		}
		if e = assertIDs(kind, s.actorKey(account), p); e != nil {
			return nil, e
		}
		category := "version"
		if kind == "create-post" {
			category = "post"
		}
		if kind == "create-reply" {
			category = "reply"
		}
		quota, e := s.quota(ctx, tx, owner, category)
		if e != nil {
			return nil, e
		}
		if num(quota, "remaining") == 0 {
			return nil, fail("forum_quota_exceeded", 429)
		}
		before, e := s.usage(ctx, tx, account)
		if e != nil {
			return nil, e
		}
		var result, locator Object
		if kind == "create-reply" {
			result, locator, e = s.createReply(ctx, tx, account, raw, p)
		} else {
			result, locator, e = s.publish(ctx, tx, account, kind, raw, p)
		}
		if e != nil {
			return nil, e
		}
		if e = s.complete(ctx, tx, account, raw, category, p, locator, result); e != nil {
			return nil, e
		}
		quota, e = s.finishBudget(ctx, tx, account, before, quota)
		if e != nil {
			return nil, e
		}
		out := clone(result)
		out["quota"] = quota
		return out, nil
	})
	var pe *pgconn.PgError
	if errors.As(e, &pe) && pe.Code == "23505" {
		return nil, fail("forum_operation_conflict", 409)
	}
	return out, e
}
func (s *Service) publish(ctx context.Context, tx pgx.Tx, account, kind, raw string, p Object) (Object, Object, error) {
	head, e := s.head(ctx, tx, str(p, "postId"), true)
	if e != nil {
		return nil, nil, e
	}
	number := int64(1)
	headVersion := int64(1)
	var previous Object
	if kind == "create-post" {
		if head != nil {
			return nil, nil, fail("forum_post_conflict", 409)
		}
		_, e = tx.Exec(ctx, "INSERT INTO forum_posts_v1(id,subject_id,account_id,head_version,state,created_at,updated_at) VALUES($1,$4,$2,1,'published',$3,$3)", p["postId"], account, s.now(), s.subject())
		if e != nil {
			return nil, nil, e
		}
	} else {
		if !s.owns(head, account) {
			return nil, nil, fail("not_found", 404)
		}
		if str(head, "state") == "withdrawn" {
			return nil, nil, fail("forum_post_withdrawn", 409)
		}
		if num(head, "head_version") != num(p, "expectedHeadVersion") {
			return nil, nil, fail("forum_head_conflict", 409)
		}
		if e = tx.QueryRow(ctx, "SELECT coalesce(max(version_number),0)+1 FROM forum_versions_v1 WHERE post_id=$1", p["postId"]).Scan(&number); e != nil {
			return nil, nil, e
		}
		previous, e = row(ctx, tx, "SELECT to_jsonb(v) FROM forum_versions_v1 v WHERE post_id=$1 ORDER BY version_number DESC LIMIT 1", p["postId"])
		if e != nil {
			return nil, nil, e
		}
		headVersion = num(head, "head_version") + 1
	}
	publication, e := s.publication(ctx, tx, account, p, previous)
	if e != nil {
		return nil, nil, e
	}
	if e = s.enforceRules(ctx, tx, account, "forum-post", str(p, "operationId"), p); e != nil {
		return nil, nil, e
	}
	permission, e := s.capture(ctx, tx, account, raw, "forum.post.publish", str(p, "versionId"), str(p, "operationId"), num(p, "publishedUntil"))
	if e != nil {
		return nil, nil, e
	}
	locator := Object{"kind": "post-version", "postId": p["postId"], "versionId": p["versionId"], "versionNumber": number}
	result := Object{"acknowledged": true, "postId": p["postId"], "versionId": p["versionId"], "versionNumber": number, "headVersion": headVersion, "permissionId": permission, "publishedUntil": p["publishedUntil"], "accountId": account, "subjectId": s.subject(), "authority": "accepted-operation-only"}
	if e = s.event(ctx, tx, account, kind, raw, p, result); e != nil {
		return nil, nil, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO forum_versions_v1(id,post_id,subject_id,account_id,version_number,publication_event_id,permission_id,payload_hash,published_until,state,created_at,topic,section_id,audience) VALUES($1,$2,$13,$3,$4,$5,$6,$7,$8,'published',$9,$10,$11,$12)`, p["versionId"], p["postId"], account, number, p["operationId"], permission, identity.Digest([]byte(raw)), time.Unix(num(p, "publishedUntil"), 0), s.now(), p["topic"], publication["sectionId"], encode(publication["audience"]), s.subject())
	if e != nil {
		return nil, nil, e
	}
	_, e = tx.Exec(ctx, "UPDATE forum_posts_v1 SET current_version_id=$2,head_version=$3,updated_at=$4 WHERE id=$1", p["postId"], p["versionId"], headVersion, s.now())
	if e != nil {
		return nil, nil, e
	}
	if a, _ := p["attachments"].([]any); len(a) > 0 {
		if e = s.bindAttachments(ctx, tx, account, p); e != nil {
			return nil, nil, e
		}
	}
	return result, locator, nil
}
func (s *Service) createReply(ctx context.Context, tx pgx.Tx, account, raw string, p Object) (Object, Object, error) {
	head, e := s.head(ctx, tx, str(p, "postId"), true)
	if e != nil {
		return nil, nil, e
	}
	if head == nil || str(head, "state") != "published" {
		return nil, nil, fail("forum_reply_source_unavailable", 403)
	}
	source, e := s.readVersion(ctx, tx, str(p, "postId"), str(p, "postVersionId"), account)
	if e != nil {
		return nil, nil, e
	}
	if str(source, "availability") != "available" {
		return nil, nil, fail("forum_reply_source_unavailable", 403)
	}
	sourceRow, e := s.version(ctx, tx, str(p, "postId"), str(p, "postVersionId"))
	if e != nil {
		return nil, nil, e
	}
	ok, e := s.participation(ctx, tx, account, sourceRow)
	if e != nil {
		return nil, nil, e
	}
	if !ok {
		return nil, nil, fail("forum_participation_denied", 403)
	}
	publication, e := s.publication(ctx, tx, account, p, sourceRow)
	if e != nil {
		return nil, nil, e
	}
	parents, e := s.snapshot(ctx, tx, sourceRow)
	if e != nil {
		return nil, nil, e
	}
	if replyTo := obj(p, "replyTo"); replyTo != nil {
		var locked string
		e = tx.QueryRow(ctx, "SELECT id::text FROM forum_replies_v1 WHERE id=$1 FOR UPDATE", replyTo["replyId"]).Scan(&locked)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, nil, fail("forum_reply_source_unavailable", 403)
		}
		if e != nil {
			return nil, nil, e
		}
		r, e := s.reply(ctx, tx, locked)
		if e != nil {
			return nil, nil, e
		}
		if str(r, "post_id") != str(p, "postId") || str(r, "post_version_id") != str(p, "postVersionId") {
			return nil, nil, fail("forum_reply_source_unavailable", 403)
		}
		view, e := s.readReply(ctx, tx, locked, account)
		if e != nil {
			return nil, nil, e
		}
		if str(view, "availability") != "available" {
			return nil, nil, fail("forum_reply_source_unavailable", 403)
		}
		snap, e := s.snapshot(ctx, tx, r)
		if e != nil {
			return nil, nil, e
		}
		parents = append(parents, snap...)
		if inherited, ok := r["parent_audience"].([]any); ok {
			parents = append(parents, inherited...)
		}
	}
	if e = s.enforceRules(ctx, tx, account, "forum-reply", str(p, "operationId"), p); e != nil {
		return nil, nil, e
	}
	permission, e := s.capture(ctx, tx, account, raw, "forum.reply.publish", str(p, "replyId"), str(p, "operationId"), num(p, "publishedUntil"))
	if e != nil {
		return nil, nil, e
	}
	locator := Object{"kind": "reply", "replyId": p["replyId"], "contentRevision": 1, "postId": p["postId"], "postVersionId": p["postVersionId"]}
	result := Object{"acknowledged": true, "replyId": p["replyId"], "revision": 1, "permissionId": permission, "publishedUntil": p["publishedUntil"], "accountId": account, "subjectId": s.subject(), "authority": "accepted-operation-only"}
	if e = s.event(ctx, tx, account, "create-reply", raw, p, result); e != nil {
		return nil, nil, e
	}
	var parentID any
	if parent := obj(p, "replyTo"); parent != nil {
		parentID = parent["replyId"]
	}
	_, audienceSpecified := p["audience"]
	_, e = tx.Exec(ctx, `INSERT INTO forum_replies_v1(id,post_id,post_version_id,reply_to_id,subject_id,account_id,revision,publication_event_id,permission_id,payload_hash,published_until,state,created_at,section_id,audience,parent_audience,audience_inherited) VALUES($1,$2,$3,$4,$15,$5,1,$6,$7,$8,$9,'published',$10,$11,$12,$13,$14)`, p["replyId"], p["postId"], p["postVersionId"], parentID, account, p["operationId"], permission, identity.Digest([]byte(raw)), time.Unix(num(p, "publishedUntil"), 0), s.now(), publication["sectionId"], encode(publication["audience"]), encode(parents), !audienceSpecified, s.subject())
	if e != nil {
		return nil, nil, e
	}
	if a, _ := p["attachments"].([]any); len(a) > 0 {
		if e = s.bindAttachments(ctx, tx, account, p); e != nil {
			return nil, nil, e
		}
	}
	return result, locator, nil
}
func (s *Service) withdraw(ctx context.Context, tx pgx.Tx, account, kind, raw string, p Object) (Object, error) {
	var target Object
	var locator, result Object
	var e error
	if kind == "withdraw-reply" {
		var locked string
		e = tx.QueryRow(ctx, "SELECT id::text FROM forum_replies_v1 WHERE id=$1 FOR UPDATE", p["replyId"]).Scan(&locked)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fail("not_found", 404)
		}
		if e != nil {
			return nil, e
		}
		target, e = s.reply(ctx, tx, locked)
		if e != nil {
			return nil, e
		}
		if !s.owns(target, account) {
			return nil, fail("not_found", 404)
		}
		if str(target, "state") == "withdrawn" || num(target, "revision") != num(p, "expectedRevision") {
			return nil, fail("forum_reply_transition", 409)
		}
		locator = Object{"kind": "reply", "replyId": p["replyId"], "contentRevision": 1}
		result = Object{"acknowledged": true, "replyId": p["replyId"], "revision": 2, "state": "withdrawn", "authority": "accepted-operation-only"}
	} else {
		head, e := s.head(ctx, tx, str(p, "postId"), true)
		if e != nil {
			return nil, e
		}
		if !s.owns(head, account) {
			return nil, fail("not_found", 404)
		}
		if str(head, "state") == "withdrawn" || num(head, "head_version") != num(p, "expectedHeadVersion") {
			return nil, fail("forum_head_conflict", 409)
		}
		locator = Object{"kind": "post", "postId": p["postId"]}
		result = Object{"acknowledged": true, "postId": p["postId"], "headVersion": num(head, "head_version") + 1, "state": "withdrawn", "authority": "accepted-operation-only"}
		if kind == "withdraw-version" {
			target, e = s.version(ctx, tx, str(p, "postId"), str(p, "versionId"))
			if e != nil {
				return nil, e
			}
			if !s.owns(target, account) {
				return nil, fail("not_found", 404)
			}
			if str(target, "state") == "withdrawn" {
				return nil, fail("forum_version_transition", 409)
			}
			locator["kind"] = "post-version"
			locator["versionId"] = p["versionId"]
			result["versionId"] = p["versionId"]
		}
	}
	result["accountId"] = null(account)
	result["subjectId"] = s.subject()
	if _, e = s.capture(ctx, tx, account, raw, "forum.withdraw", str(p, "operationId"), str(p, "operationId"), 0); e != nil {
		return nil, e
	}
	if e = s.event(ctx, tx, account, kind, raw, p, result); e != nil {
		return nil, e
	}
	switch kind {
	case "withdraw-reply":
		_, e = tx.Exec(ctx, "UPDATE forum_replies_v1 SET state='withdrawn',revision=2 WHERE id=$1", p["replyId"])
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=coalesce(revoked_at,$2) WHERE id=$1", target["permission_id"], s.now())
		}
	case "withdraw-version":
		_, e = tx.Exec(ctx, "UPDATE forum_versions_v1 SET state='withdrawn' WHERE id=$1", p["versionId"])
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=coalesce(revoked_at,$2) WHERE id=$1", target["permission_id"], s.now())
		}
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE forum_posts_v1 SET head_version=head_version+1,current_version_id=CASE WHEN current_version_id=$2 THEN NULL ELSE current_version_id END,updated_at=$3 WHERE id=$1", p["postId"], p["versionId"], s.now())
		}
	default:
		_, e = tx.Exec(ctx, "UPDATE forum_posts_v1 SET state='withdrawn',head_version=head_version+1,current_version_id=NULL,updated_at=$2 WHERE id=$1", p["postId"], s.now())
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE forum_versions_v1 SET state='withdrawn' WHERE post_id=$1", p["postId"])
		}
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE forum_permissions_v1 SET revoked_at=coalesce(revoked_at,$2) WHERE id IN (SELECT permission_id FROM forum_versions_v1 WHERE post_id=$1)", p["postId"], s.now())
		}
	}
	if e != nil {
		return nil, e
	}
	if e = s.complete(ctx, tx, account, raw, "", p, locator, result); e != nil {
		return nil, e
	}
	return result, nil
}
