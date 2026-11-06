package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/jackc/pgx/v5"
)

type AccountCommentActor struct {
	AccountID string
	Authority accountlinks.PortalAuthorization
}

// SubmitAccount records an ordinary public reply under the authenticated account.
func (c *CommentService) SubmitAccount(ctx context.Context, a AccountCommentActor, payloadJSON string) (any, error) {
	p, err := parseComment(Envelope{PayloadJSON: payloadJSON})
	if err != nil {
		return nil, err
	}
	kind := str(p, "kind")
	if c == nil || c.Service == nil || c.Pool == nil || c.Links == nil || c.Writes == nil || c.Endpoint == "" || a.Authority == nil || !validID(a.AccountID) {
		return nil, fail("comment_account_service_unavailable", 503)
	}
	return postgres.InTx(ctx, c.Pool, func(tx pgx.Tx) (any, error) {
		account, e := c.Links.ResolvePortalWithin(ctx, tx, a.Authority, c.Endpoint, a.AccountID, a.AccountID, true)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "comment-operation:"+str(p, "id")); e != nil {
			return nil, e
		}
		prior, e := c.commentEvent(ctx, tx, str(p, "id"))
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["account_id"] != account["id"] || prior["payload_hash"] != identity.Digest([]byte(payloadJSON)) {
				return nil, fail("comment_conflict")
			}
			return Object{"commentId": prior["comment_id"], "operationId": prior["id"], "revision": prior["revision"], "acknowledged": true, "taskStateChanged": false, "participationCreated": false}, nil
		}
		task, e := c.RequireTaskWithin(ctx, tx, nil, str(p, "taskId"), false)
		if e != nil {
			return nil, e
		}
		if task["rootGrant"].(deviceauth.ConsentIntent).Visibility != "Public" {
			return nil, fail("not_found", 404)
		}
		if kind == "create" && (!enrollmentOpen(obj(task, "snapshot"), c.now()) || task["paused"] == true || contains(stringsOf(obj(task, "governance")["scopes"]), "new-participation-paused")) {
			return nil, fail("task_enrollment_closed", 403)
		}
		if kind != "retract" && account["restricted_until"] != nil && millis(account["restricted_until"]) > c.now()*1000 {
			return nil, fail("community_restricted", 403)
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "comment-object:"+str(p, "commentId")); e != nil {
			return nil, e
		}
		current, e := c.commentRow(ctx, tx, str(p, "commentId"), true)
		if e != nil {
			return nil, e
		}
		if kind == "create" {
			if current != nil || num(p["expectedRevision"]) != 0 {
				return nil, fail("comment_revision_conflict")
			}
			current = Object{"id": p["commentId"], "task_id": p["taskId"], "revision": 0, "created_at": stamp(c.now()), "expires_at": stamp(c.now() + 90*86400)}
		} else {
			if current == nil || current["subject_id"] != nil || current["account_id"] != account["id"] || current["task_id"] != p["taskId"] {
				return nil, fail("not_found", 404)
			}
			if num(current["revision"]) != num(p["expectedRevision"]) {
				return nil, fail("comment_revision_conflict")
			}
			if current["state"] == "retracted" {
				return nil, fail("comment_retracted")
			}
			if kind != "retract" && millis(current["expires_at"]) <= c.now()*1000 {
				return nil, fail("comment_expired", 403)
			}
			if kind == "edit" && millis(current["created_at"])+86400*1000 <= c.now()*1000 {
				return nil, fail("comment_edit_window_closed")
			}
		}
		revision := num(current["revision"]) + 1
		if revision > c.rules().MaxVersions && kind != "retract" {
			return nil, fail("comment_revision_limit", 413)
		}
		if p["replyTo"] != nil {
			ref := obj(p, "replyTo")
			parent, e := c.ReadWithin(ctx, tx, nil, str(ref, "id"), 0, false)
			if e != nil {
				return nil, e
			}
			if parent["taskId"] != p["taskId"] || num(parent["revision"]) != num(ref["revision"]) || parent["body"] == nil {
				return nil, fail("comment_reply_unavailable")
			}
		}
		checks := Object{"reasons": current["rule_reasons"], "state": current["review_state"], "fingerprints": Object{"text": nil, "links": []string{}}}
		if kind != "retract" {
			checks, e = c.inspectCommentRules(ctx, tx, account, current, p["body"].(jsText))
			if e != nil {
				return nil, e
			}
		}
		var quota any
		if kind == "create" {
			quota, e = c.Writes.ConsumeWithin(ctx, tx, publicwrites.Actor{AccountID: a.AccountID, Authority: a.Authority}, publicwrites.Operation{Kind: "comment", OperationID: str(p, "id"), PayloadHash: identity.Digest([]byte(payloadJSON)), TaskID: str(p, "taskId")})
			if e != nil {
				return nil, e
			}
		}
		reply := obj(p, "replyTo")
		policy := c.rules()
		if kind == "create" {
			_, e = tx.Exec(ctx, `INSERT INTO task_comments_v2(id,task_id,subject_id,account_id,revision,current_event_id,reply_to_id,reply_to_revision,rule_version,rule_reasons,review_state,created_at,expires_at) VALUES($1,$2,NULL,$3,1,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`, p["commentId"], p["taskId"], account["id"], p["id"], reply["id"], reply["revision"], policy.Version, jsonBytes(checks["reasons"]), checks["state"], current["created_at"], current["expires_at"])
			if e != nil {
				return nil, e
			}
		} else {
			state := "active"
			if kind == "retract" {
				state = "retracted"
			}
			_, e = tx.Exec(ctx, `UPDATE task_comments_v2 SET revision=$2,current_event_id=$3,state=$4,review_state=$5,rule_version=$6,rule_reasons=$7::jsonb,review_event_id=NULL WHERE id=$1`, p["commentId"], revision, p["id"], state, checks["state"], policy.Version, jsonBytes(checks["reasons"]))
			if e != nil {
				return nil, e
			}
		}
		fp := obj(checks, "fingerprints")
		_, e = tx.Exec(ctx, `INSERT INTO task_comment_events_v2(id,comment_id,task_id,subject_id,account_id,revision,kind,consent_id,payload_text,payload_hash,text_fingerprint,link_fingerprints,created_at) VALUES($1,$2,$3,NULL,$4,$10,$11,NULL,$5,$6,$7,$8::jsonb,$9)`, p["id"], p["commentId"], p["taskId"], account["id"], payloadJSON, identity.Digest([]byte(payloadJSON)), fp["text"], jsonBytes(fp["links"]), stamp(c.now()), revision, kind)
		if e != nil {
			return nil, e
		}
		state := str(checks, "state")
		if kind == "retract" {
			state = "retracted"
		} else if state == "clear" {
			state = "visible"
		}
		return Object{"commentId": p["commentId"], "operationId": p["id"], "revision": revision, "state": state, "rule": Object{"version": policy.Version, "reasons": checks["reasons"]}, "quota": quota, "taskStateChanged": false, "participationCreated": false}, nil
	})
}

// ReceiptAccount reads only an exact operation and payload hash for this session.
func (c *CommentService) ReceiptAccount(ctx context.Context, a AccountCommentActor, id, hash string) (any, error) {
	if !validID(id) || !hashPattern.MatchString(hash) {
		return nil, fail("invalid_comment_receipt", 400)
	}
	if c == nil || c.Service == nil || c.Pool == nil || c.Links == nil || a.Authority == nil || !validID(a.AccountID) {
		return nil, fail("comment_account_service_unavailable", 503)
	}
	return postgres.InTx(ctx, c.Pool, func(tx pgx.Tx) (any, error) {
		account, e := c.Links.ResolvePortalWithin(ctx, tx, a.Authority, c.Endpoint, a.AccountID, a.AccountID, false)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "comment-operation:"+id); e != nil {
			return nil, e
		}
		event, e := c.commentEvent(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		if event == nil || event["account_id"] != account["id"] {
			return Object{"state": "absent"}, nil
		}
		if event["payload_hash"] != hash {
			return nil, fail("comment_conflict")
		}
		return Object{"commentId": event["comment_id"], "operationId": event["id"], "revision": event["revision"], "acknowledged": true, "state": "accepted", "taskStateChanged": false}, nil
	})
}
