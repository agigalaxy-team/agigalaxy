package taskmaterials

import (
	"context"
	"encoding/json"
	"math"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

type CommentRules struct {
	Version                                                                                 string
	DuplicateWindowSeconds, DuplicateThreshold, LinkTaskThreshold, MaxMentions, MaxVersions int64
}

func DefaultCommentRules() CommentRules { return CommentRules{"comment-rules/1", 86400, 3, 4, 8, 100} }

type CommentService struct {
	*Service
	Rules           *CommentRules
	IsBlockedWithin func(context.Context, pgx.Tx, string, string) (bool, error)
	NormalizeURL    func(string) (string, error)
}

func (c *CommentService) rules() CommentRules {
	if c.Rules != nil {
		return *c.Rules
	}
	return DefaultCommentRules()
}
func (c *CommentService) commentRow(ctx context.Context, tx pgx.Tx, id string, lock bool) (Object, error) {
	query := "SELECT to_jsonb(c) FROM task_comments_v2 c WHERE id=$1"
	if lock {
		query += " FOR UPDATE"
	}
	return row(ctx, tx, query, id)
}
func (c *CommentService) commentEvent(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	return row(ctx, tx, "SELECT to_jsonb(e) FROM task_comment_events_v2 e WHERE id=$1", id)
}
func (c *CommentService) commentGrant(ctx context.Context, tx pgx.Tx, event Object) (deviceauth.ConsentIntent, error) {
	return c.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(event, "consent_id"), SubjectID: str(event, "subject_id"), Action: "comment.publish", ObjectID: str(event, "id"), Recipient: c.Endpoint, PayloadJSON: str(event, "payload_text")})
}
func (c *CommentService) heldWithin(ctx context.Context, tx pgx.Tx, id string, revision int64) ([]Object, error) {
	return rows(ctx, tx, "SELECT jsonb_build_object('id',id,'pause_until',pause_until) FROM comment_reports_v2 WHERE comment_id=$1 AND comment_revision=$2 AND pause_until>$3 ORDER BY id", id, revision, stamp(c.now()))
}
func (c *CommentService) commentSource(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, current Object, revision int64) (Object, error) {
	task, e := c.RequireTaskWithin(ctx, tx, a, str(current, "task_id"), false)
	if e != nil {
		return nil, e
	}
	if millis(current["expires_at"]) <= c.now()*1000 {
		return nil, fail("comment_expired", 403)
	}
	source, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_comment_events_v2 e WHERE comment_id=$1 AND revision=$2", current["id"], revision)
	if e != nil {
		return nil, e
	}
	if source == nil || str(source, "payload_text") == "" || source["erased_at"] != nil {
		return nil, fail("comment_source_erased", 403)
	}
	grant, e := c.commentGrant(ctx, tx, source)
	if e != nil {
		return nil, e
	}
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	if !c.visible(grant, viewer) {
		return nil, fail("comment_permission_unavailable", 403)
	}
	payload, e := parseObject(str(source, "payload_text"))
	if e != nil {
		return nil, e
	}
	if _, exists := payload["body"]; exists {
		body, e := rawCommentBody(str(source, "payload_text"))
		if e != nil {
			return nil, e
		}
		payload["body"] = body
	}
	return Object{"task": task, "source": source, "grant": grant, "payload": payload}, nil
}
func (c *CommentService) blocked(ctx context.Context, tx pgx.Tx, viewer, author string) (bool, error) {
	if viewer == "" || author == "" {
		return false, nil
	}
	if c.IsBlockedWithin == nil {
		return false, fail("comment_block_reader_unavailable", 503)
	}
	return c.IsBlockedWithin(ctx, tx, viewer, author)
}

// ReadWithin is shared with exact-revision moderation and notification readers;
// review=true is reserved for a caller that already authorized the real report.
func (c *CommentService) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, revision int64, review bool) (Object, error) {
	current, e := c.commentRow(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	if current == nil {
		return nil, fail("not_found", 404)
	}
	if _, e = c.RequireTaskWithin(ctx, tx, a, str(current, "task_id"), false); e != nil {
		return nil, e
	}
	if revision == 0 {
		revision = num(current["revision"])
	}
	own := a != nil && a.SubjectID == str(current, "subject_id")
	if revision != num(current["revision"]) && !own && !review {
		return nil, fail("comment_version_unavailable", 404)
	}
	state := "historical"
	if current["state"] == "retracted" {
		state = "retracted"
	} else if revision == num(current["revision"]) {
		state = str(current, "review_state")
	}
	held, e := c.heldWithin(ctx, tx, id, revision)
	if e != nil {
		return nil, e
	}
	if len(held) > 0 {
		state = "governance-hidden"
	}
	source, e := c.commentSource(ctx, tx, a, current, revision)
	if e != nil {
		if fault.Status(e) != 403 && fault.Status(e) != 404 {
			return nil, e
		}
		state = strings.ReplaceAll(fault.Code(e), "_", "-")
		source = nil
	}
	allowed := source != nil && current["state"] != "retracted" && (review || own || !contains([]string{"pending-review", "rejected", "governance-hidden"}, state))
	if a != nil && !own && !review {
		blocked, e := c.blocked(ctx, tx, a.SubjectID, str(current, "subject_id"))
		if e != nil {
			return nil, e
		}
		if blocked {
			state = "blocked"
		}
	}
	var content any
	if allowed && state != "blocked" {
		content = obj(source, "payload")["body"]
	}
	var reply any
	if current["reply_to_id"] != nil {
		reference := Object{"id": current["reply_to_id"], "revision": current["reply_to_revision"], "body": nil, "state": "unavailable"}
		reply = reference
		parent, e := c.commentRow(ctx, tx, str(current, "reply_to_id"), false)
		if e != nil {
			return nil, e
		}
		if parent != nil && num(parent["revision"]) == num(current["reply_to_revision"]) && parent["state"] == "active" && !contains([]string{"pending-review", "rejected"}, str(parent, "review_state")) {
			held, e := c.heldWithin(ctx, tx, str(parent, "id"), num(parent["revision"]))
			if e != nil {
				return nil, e
			}
			if len(held) == 0 {
				p, e := c.commentSource(ctx, tx, a, parent, num(parent["revision"]))
				if e != nil {
					if fault.Status(e) != 403 && fault.Status(e) != 404 {
						return nil, e
					}
				} else {
					blocked := false
					if a != nil {
						blocked, e = c.blocked(ctx, tx, a.SubjectID, str(parent, "subject_id"))
						if e != nil {
							return nil, e
						}
					}
					if !blocked {
						if body, ok := obj(p, "payload")["body"].(jsText); ok {
							reference["body"] = body[:min(len(body), 240)]
						}
						reference["state"] = "visible"
					}
				}
			}
		}
	}
	if content != nil && contains([]string{"clear", "approved"}, state) {
		state = "visible"
	}
	out := Object{"commentId": id, "taskId": current["task_id"], "authorId": current["subject_id"], "revision": revision, "currentRevision": current["revision"], "state": state, "body": content, "replyTo": reply, "createdAt": isoValue(current["created_at"]), "expiresAt": isoValue(current["expires_at"]), "canEdit": own && current["state"] == "active" && source != nil && millis(current["created_at"])+86400*1000 > c.now()*1000, "canCorrect": own && current["state"] == "active" && source != nil, "canRetract": own && current["state"] == "active", "taskStateChanged": false, "participationCreated": false, "capabilityVerified": false, "authority": "current-authorized-comment-view"}
	if own || review {
		restrictions := []any{}
		for _, h := range held {
			restrictions = append(restrictions, Object{"reportId": h["id"], "until": isoValue(h["pause_until"])})
		}
		out["rule"] = Object{"version": current["rule_version"], "reasons": current["rule_reasons"]}
		out["activeRestrictions"] = restrictions
	}
	return out, nil
}
func parseComment(input Envelope) (Object, error) {
	invalid := func() (Object, error) { return nil, fail("invalid_comment_payload", 400) }
	if len([]byte(input.PayloadJSON)) > 30000 {
		return invalid()
	}
	v, e := parseObject(input.PayloadJSON)
	if e != nil || !validInt(v["schemaVersion"], 2, 2) || !validID(str(v, "id")) || !validID(str(v, "commentId")) || !validID(str(v, "taskId")) || !validInt(v["expectedRevision"], 0, math.MaxInt64) {
		return invalid()
	}
	required := []string{"schemaVersion", "id", "commentId", "taskId", "expectedRevision", "kind"}
	optional := []string{}
	switch str(v, "kind") {
	case "create", "edit", "correct":
		required = append(required, "body", "visibility")
		if v["visibility"] != "inherit-task" {
			return invalid()
		}
		body, e := rawCommentBody(input.PayloadJSON)
		if e != nil {
			return invalid()
		}
		v["body"] = body
		if v["kind"] == "correct" {
			required = append(required, "reason")
			reason, e := rawCommentText(input.PayloadJSON, "reason", 600)
			if e != nil {
				return invalid()
			}
			v["reason"] = reason
		}
		if v["kind"] == "create" {
			optional = append(optional, "replyTo")
			if ref, ok := v["replyTo"]; ok && ref != nil {
				r, ok := ref.(map[string]any)
				if !ok || !exactFields(r, []string{"id", "revision"}, nil) || !validID(str(r, "id")) || !validInt(r["revision"], 1, math.MaxInt64) {
					return invalid()
				}
			}
			copy := Object{}
			for key, value := range v {
				if key != "replyTo" {
					copy[key] = value
				}
			}
			if !exactFields(copy, required, nil) {
				return invalid()
			}
			if _, ok := v["replyTo"]; !ok {
				v["replyTo"] = nil
			}
			return v, nil
		}
	case "retract":
	default:
		return invalid()
	}
	if !exactFields(v, required, optional) {
		return invalid()
	}
	return v, nil
}
func (c *CommentService) Get(ctx context.Context, a *Actor, id string) (any, error) {
	if !validID(id) {
		return nil, fail("not_found", 404)
	}
	if a == nil {
		return postgres.InTx(ctx, c.Pool, func(tx pgx.Tx) (any, error) { return c.ReadWithin(ctx, tx, nil, id, 0, false) })
	}
	return c.run(ctx, *a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		return c.ReadWithin(ctx, tx, &a.Actor, id, 0, false)
	})
}
func (c *CommentService) Receipt(ctx context.Context, a Actor, id, hash string) (any, error) {
	if !validID(id) || !hashPattern.MatchString(hash) {
		return nil, fail("invalid_comment_receipt", 400)
	}
	return c.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		event, e := c.commentEvent(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		if event == nil || event["subject_id"] != a.SubjectID {
			return Object{"state": "absent", "operationId": id}, nil
		}
		state := "conflict"
		out := Object{"state": state, "operationId": id, "authority": "accepted-event-only; not-current-content"}
		if event["payload_hash"] == hash {
			out["state"] = "acknowledged"
			out["commentId"] = event["comment_id"]
			out["revision"] = event["revision"]
			out["consentId"] = event["consent_id"]
		}
		return out, nil
	})
}
func (c *CommentService) commentReplay(ctx context.Context, tx pgx.Tx, a Actor, p Object, input Envelope) (Object, error) {
	prior, e := c.commentEvent(ctx, tx, str(p, "id"))
	if e != nil || prior == nil {
		return nil, e
	}
	if prior["subject_id"] != a.SubjectID || prior["comment_id"] != p["commentId"] || prior["task_id"] != p["taskId"] || prior["consent_id"] != input.ConsentID || prior["payload_hash"] != identity.Digest([]byte(input.PayloadJSON)) {
		return nil, fail("comment_conflict")
	}
	return Object{"commentId": prior["comment_id"], "operationId": prior["id"], "revision": prior["revision"], "acknowledged": true, "taskStateChanged": false, "authority": "accepted-event-only; recheck-current-view"}, nil
}
func commentBodyFromView(v any) jsText {
	switch x := v.(type) {
	case jsText:
		return x
	case string:
		return jsTextFromString(x)
	}
	return nil
}
func jsTextFromString(s string) jsText { raw, _ := json.Marshal(s); v, _ := parseJSText(raw); return v }
