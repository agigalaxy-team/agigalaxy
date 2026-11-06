package communitygrowth

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// AccountAuthority is the authenticated portal account's transaction-time check.
type AccountAuthority interface {
	Account(context.Context, pgx.Tx, string, string) error
}

// ScopedRecognitionCommand allows a section maintainer to recognize the actual
// author of a post or reply in that section. Authorization is checked inside
// the same transaction as the scope and the original operation receipt.
func (s *Service) ScopedRecognitionCommand(ctx context.Context, account string, authority AccountAuthority, input Object) (Object, error) {
	if _, e := uuid.Parse(account); e != nil || authority == nil {
		return nil, fault.New("official_account_login_required", 401)
	}
	op, objectID, objectKind := str(input, "operationId"), str(input, "objectId"), str(input, "objectKind")
	if _, e := uuid.Parse(op); e != nil {
		return nil, invalid()
	}
	if _, e := uuid.Parse(objectID); e != nil {
		return nil, invalid()
	}
	if str(input, "kind") != "recognition-save" || str(input, "recognitionKind") != "content" || (objectKind != "post" && objectKind != "reply") {
		return nil, invalid()
	}
	bytes, e := identity.Canonical(input)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(bytes)
	owner := "account:" + account
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := authority.Account(ctx, tx, s.Endpoint, account); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912765))`, s.Endpoint+":"+op); e != nil {
			return nil, e
		}
		var priorHash, priorOwner string
		var prior Object
		e := tx.QueryRow(ctx, `SELECT request_hash,actor_id,result FROM community_growth_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, op).Scan(&priorHash, &priorOwner, &prior)
		if e == nil {
			if priorHash != hash || priorOwner != owner {
				return nil, fault.New("community_growth_operation_conflict", 409)
			}
			return prior, nil
		}
		if !noRows(e) {
			return nil, e
		}
		var actualAuthor, maintainer string
		q := `SELECT p.account_id::text,sec.maintainer_account_id::text FROM forum_posts_v1 p JOIN forum_versions_v1 v ON v.id=p.current_version_id JOIN forum_sections_v2 sec ON sec.id=v.section_id JOIN community_accounts a ON a.id=p.account_id WHERE p.id=$1 AND a.endpoint=$2 AND p.state='published' AND sec.state='active' FOR SHARE OF p,v,sec`
		if objectKind == "reply" {
			q = `SELECT r.account_id::text,sec.maintainer_account_id::text FROM forum_replies_v1 r JOIN forum_sections_v2 sec ON sec.id=r.section_id JOIN community_accounts a ON a.id=r.account_id WHERE r.id=$1 AND a.endpoint=$2 AND r.state='published' AND sec.state='active' FOR SHARE OF r,sec`
		}
		e = tx.QueryRow(ctx, q, objectID, s.Endpoint).Scan(&actualAuthor, &maintainer)
		if noRows(e) {
			return nil, fault.New("community_growth_object_not_found", 404)
		}
		if e != nil {
			return nil, e
		}
		if maintainer != account {
			return nil, fault.New("community_growth_scope_denied", 403)
		}
		if actualAuthor != str(input, "accountId") {
			return nil, invalid()
		}
		if e = s.ensureDefaults(ctx, tx); e != nil {
			return nil, e
		}
		result, e := s.saveRecognition(ctx, tx, Actor{ID: owner}, input)
		if e != nil {
			return nil, e
		}
		result["operationId"] = op
		result["replayed"] = false
		_, e = tx.Exec(ctx, `INSERT INTO community_growth_operations_v1(endpoint,operation_id,actor_id,kind,request_hash,result,created_at) VALUES($1,$2,$3,'scoped-recognition-save',$4,$5,$6)`, s.Endpoint, op, owner, hash, jsonText(result), s.now())
		if e != nil {
			return nil, e
		}
		return result, nil
	})
}

func (s *Service) ScopedRecognitionReceipt(ctx context.Context, account string, authority AccountAuthority, operationID string) (Object, error) {
	if _, e := uuid.Parse(account); e != nil || authority == nil {
		return nil, fault.New("official_account_login_required", 401)
	}
	if _, e := uuid.Parse(operationID); e != nil {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := authority.Account(ctx, tx, s.Endpoint, account); e != nil {
			return nil, e
		}
		var result Object
		e := tx.QueryRow(ctx, `SELECT result FROM community_growth_operations_v1 WHERE endpoint=$1 AND operation_id=$2 AND actor_id=$3 AND kind='scoped-recognition-save'`, s.Endpoint, operationID, "account:"+account).Scan(&result)
		if noRows(e) {
			return Object{"state": "not-recorded", "operationId": operationID}, nil
		}
		if e != nil {
			return nil, e
		}
		return Object{"state": "recorded", "operationId": operationID, "result": result}, nil
	})
}

// ScopedRecognitionStatus reports whether this authenticated account is the
// current maintainer of the content's active section.
func (s *Service) ScopedRecognitionStatus(ctx context.Context, account string, authority AccountAuthority, kind, id string) (Object, error) {
	if _, e := uuid.Parse(account); e != nil || authority == nil {
		return nil, fault.New("official_account_login_required", 401)
	}
	if _, e := uuid.Parse(id); e != nil || (kind != "post" && kind != "reply") {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := authority.Account(ctx, tx, s.Endpoint, account); e != nil {
			return nil, e
		}
		author, section, maintainer, e := s.scopedContentWithin(ctx, tx, kind, id)
		if fault.Code(e) == "community_growth_object_not_found" {
			return Object{"objectKind": kind, "objectId": id, "accountId": nil, "sectionId": nil, "canManage": false}, nil
		}
		if e != nil {
			return nil, e
		}
		return Object{"objectKind": kind, "objectId": id, "accountId": author, "sectionId": section, "canManage": maintainer == account}, nil
	})
}

func (s *Service) scopedContentWithin(ctx context.Context, tx pgx.Tx, kind, id string) (string, string, string, error) {
	q := `SELECT p.account_id::text,sec.id::text,sec.maintainer_account_id::text FROM forum_posts_v1 p JOIN forum_versions_v1 v ON v.id=p.current_version_id JOIN forum_sections_v2 sec ON sec.id=v.section_id JOIN community_accounts a ON a.id=p.account_id WHERE p.id=$1 AND a.endpoint=$2 AND p.state='published' AND sec.state='active' FOR SHARE OF p,v,sec`
	if kind == "reply" {
		q = `SELECT r.account_id::text,sec.id::text,sec.maintainer_account_id::text FROM forum_replies_v1 r JOIN forum_sections_v2 sec ON sec.id=r.section_id JOIN community_accounts a ON a.id=r.account_id WHERE r.id=$1 AND a.endpoint=$2 AND r.state='published' AND sec.state='active' FOR SHARE OF r,sec`
	}
	var author, section, maintainer string
	e := tx.QueryRow(ctx, q, id, s.Endpoint).Scan(&author, &section, &maintainer)
	if noRows(e) {
		return "", "", "", fault.New("community_growth_object_not_found", 404)
	}
	return author, section, maintainer, e
}

// ScopedRecognitionQuery returns the original content recognitions in scope;
// it does not include account weights or other management-only material.
func (s *Service) ScopedRecognitionQuery(ctx context.Context, account string, authority AccountAuthority, kind, id string, limit int, after string) (Object, error) {
	if _, e := uuid.Parse(account); e != nil || authority == nil {
		return nil, fault.New("official_account_login_required", 401)
	}
	if _, e := uuid.Parse(id); e != nil || (kind != "post" && kind != "reply") {
		return nil, invalid()
	}
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 100 {
		return nil, invalid()
	}
	if after != "" {
		if _, e := uuid.Parse(after); e != nil {
			return nil, invalid()
		}
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := authority.Account(ctx, tx, s.Endpoint, account); e != nil {
			return nil, e
		}
		author, section, maintainer, e := s.scopedContentWithin(ctx, tx, kind, id)
		if e != nil {
			return nil, e
		}
		if maintainer != account {
			return nil, fault.New("community_growth_scope_denied", 403)
		}
		var cursor any
		if after != "" {
			cursor = after
		}
		rows, e := tx.Query(ctx, `SELECT jsonb_build_object('id',id,'accountId',account_id,'objectKind',object_kind,'objectId',object_id,'domain',domain,'reason',reason,'active',active,'revision',revision,'issuedBy',issued_by,'createdAt',created_at,'updatedAt',updated_at) FROM community_growth_recognitions_v1 WHERE endpoint=$1 AND kind='content' AND object_kind=$2 AND object_id=$3 AND ($4::uuid IS NULL OR id>$4::uuid) ORDER BY id LIMIT $5`, s.Endpoint, kind, id, cursor, limit+1)
		if e != nil {
			return nil, e
		}
		items, e := rowsObjects(rows)
		if e != nil {
			return nil, e
		}
		var next any
		if len(items) > limit {
			items = items[:limit]
			next = items[len(items)-1]["id"]
		}
		return Object{"objectKind": kind, "objectId": id, "accountId": author, "sectionId": section, "items": items, "nextAfter": next}, nil
	})
}
