package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/jackc/pgx/v5"
)

func (c *CommentService) Submit(ctx context.Context, a Actor, input Envelope) (any, error) {
	p, e := parseComment(input)
	if e != nil {
		return nil, e
	}
	kind := str(p, "kind")
	return c.run(ctx, a, "assistance", true, kind == "retract", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "comment-operation:"+str(p, "id")); e != nil {
			return nil, e
		}
		if prior, e := c.commentReplay(ctx, tx, a, p, input); e != nil || prior != nil {
			return prior, e
		}
		var task, account Object
		if kind != "retract" {
			task, e = c.RequireTaskWithin(ctx, tx, &a.Actor, str(p, "taskId"), false)
			if e != nil {
				return nil, e
			}
			links := c.Links
			if links == nil && c.Writes != nil {
				links = c.Writes.Links
			}
			if links == nil || c.Writes == nil {
				return nil, fail("comment_account_service_unavailable", 503)
			}
			account, e = links.ForScope("assistance").ResolveWithin(ctx, tx, a.Actor, "", true)
			if e != nil {
				return nil, e
			}
		}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "comment-object:"+str(p, "commentId")); e != nil {
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
			current = Object{"id": p["commentId"], "task_id": p["taskId"], "subject_id": a.SubjectID, "revision": 0, "created_at": stamp(c.now()), "expires_at": stamp(c.now() + 90*86400)}
		} else {
			if current == nil || current["subject_id"] != a.SubjectID || current["task_id"] != p["taskId"] {
				return nil, fail("not_found", 404)
			}
			if num(current["revision"]) != num(p["expectedRevision"]) {
				return nil, fail("comment_revision_conflict")
			}
			if current["state"] == "retracted" {
				return nil, fail("comment_retracted")
			}
		}
		revision := num(current["revision"]) + 1
		policy := c.rules()
		if revision > policy.MaxVersions && kind != "retract" {
			return nil, fail("comment_revision_limit", 413)
		}
		grant, e := c.commentGrant(ctx, tx, Object{"id": p["id"], "subject_id": a.SubjectID, "consent_id": input.ConsentID, "payload_text": input.PayloadJSON})
		if e != nil {
			return nil, e
		}
		if kind == "retract" {
			if grant.Visibility != "Private" || len(grant.Viewers) > 0 {
				return nil, fail("comment_retraction_private", 403)
			}
		} else {
			if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
				return nil, fail("comment_author_deletion_pending", 403)
			}
			if millis(current["expires_at"]) <= c.now()*1000 {
				return nil, fail("comment_expired", 403)
			}
			if kind == "edit" && millis(current["created_at"])+86400*1000 <= c.now()*1000 {
				return nil, fail("comment_edit_window_closed")
			}
			if account["restricted_until"] != nil && millis(account["restricted_until"]) > c.now()*1000 {
				return nil, fail("community_restricted", 403)
			}
			root := task["rootGrant"].(deviceauth.ConsentIntent)
			if grant.Visibility != root.Visibility {
				return nil, fail("comment_visibility_mismatch", 403)
			}
			if root.Visibility == "Private" {
				for _, id := range grant.Viewers {
					if !c.visible(root, id) {
						return nil, fail("comment_visibility_mismatch", 403)
					}
				}
			}
			if kind == "create" && p["replyTo"] != nil {
				reference := obj(p, "replyTo")
				parent, e := c.ReadWithin(ctx, tx, &a.Actor, str(reference, "id"), 0, false)
				if e != nil {
					return nil, e
				}
				if parent["taskId"] != p["taskId"] || num(parent["revision"]) != num(reference["revision"]) || parent["body"] == nil {
					return nil, fail("comment_reply_unavailable")
				}
			}
		}
		checks := Object{"reasons": current["rule_reasons"], "state": current["review_state"], "fingerprints": Object{"text": nil, "links": []string{}}}
		if checks["reasons"] == nil {
			checks["reasons"] = []string{}
		}
		if checks["state"] == nil {
			checks["state"] = "clear"
		}
		if kind != "retract" {
			checks, e = c.inspectCommentRules(ctx, tx, account, current, p["body"].(jsText))
			if e != nil {
				return nil, e
			}
		}
		var quota any
		if kind == "create" && task["rootGrant"].(deviceauth.ConsentIntent).Visibility == "Public" {
			quota, e = c.Writes.ConsumeWithin(ctx, tx, publicwrites.Actor{Device: &a.Actor, Scope: "assistance"}, publicwrites.Operation{Kind: "comment", OperationID: str(p, "id"), PayloadHash: identity.Digest([]byte(input.PayloadJSON)), TaskID: str(p, "taskId")})
			if e != nil {
				return nil, e
			}
		}
		if kind == "create" {
			reply := obj(p, "replyTo")
			if _, e = tx.Exec(ctx, `INSERT INTO task_comments_v2(id,task_id,subject_id,account_id,revision,current_event_id,reply_to_id,reply_to_revision,rule_version,rule_reasons,review_state,created_at,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`, p["commentId"], p["taskId"], a.SubjectID, account["id"], revision, p["id"], reply["id"], reply["revision"], policy.Version, jsonBytes(checks["reasons"]), checks["state"], current["created_at"], current["expires_at"]); e != nil {
				return nil, e
			}
		} else {
			state := "active"
			if kind == "retract" {
				state = "retracted"
			}
			if _, e = tx.Exec(ctx, `UPDATE task_comments_v2 SET revision=$2,current_event_id=$3,state=$4,review_state=$5,rule_version=$6,rule_reasons=$7::jsonb,review_event_id=NULL WHERE id=$1`, p["commentId"], revision, p["id"], state, checks["state"], policy.Version, jsonBytes(checks["reasons"])); e != nil {
				return nil, e
			}
		}
		fp := obj(checks, "fingerprints")
		if _, e = tx.Exec(ctx, `INSERT INTO task_comment_events_v2(id,comment_id,task_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,text_fingerprint,link_fingerprints,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`, p["id"], p["commentId"], p["taskId"], a.SubjectID, revision, kind, input.ConsentID, input.PayloadJSON, identity.Digest([]byte(input.PayloadJSON)), fp["text"], jsonBytes(fp["links"]), stamp(c.now())); e != nil {
			return nil, e
		}
		if e = c.commentAudit(ctx, tx, a, auth, str(p, "id"), "comment."+kind, false); e != nil {
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
func (c *CommentService) commentAudit(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, id, action string, governance bool) error {
	table, scope := "task_comment_events_v2", "assistance"
	if governance {
		table, scope = "comment_governance_events_v2", "moderation"
	}
	if !contains(auth.CredentialScopes, scope) || a.BindingID == "" {
		return fail("comment_audit_authorization_unavailable", 503)
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,$7,c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM `+table+` e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE e.id=$2::text::uuid AND e.subject_id=$1 AND c.subject_id=$1 AND b.subject_id=$1`, a.SubjectID, id, action, a.HTTPRequestID, jsonBytes(auth.CredentialScopes), a.BindingID, scope)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail("comment_audit_context_unavailable", 503)
	}
	return nil
}
