package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (g *CommentGovernance) accountRun(ctx context.Context, a AccountCommentActor, write bool, fn func(pgx.Tx) (any, error)) (any, error) {
	if g == nil || g.CommentService == nil || g.Service == nil || g.Pool == nil || g.Links == nil || a.Authority == nil || !validID(a.AccountID) {
		return nil, fail("official_account_login_required", 401)
	}
	return postgres.InTx(ctx, g.Pool, func(tx pgx.Tx) (any, error) {
		_, e := g.Links.ResolvePortalWithin(ctx, tx, a.Authority, g.Endpoint, a.AccountID, a.AccountID, write)
		if e != nil {
			return nil, e
		}
		return fn(tx)
	})
}
func (g *CommentGovernance) accountViewWithin(ctx context.Context, tx pgx.Tx, account, id string) (Object, error) {
	r, e := row(ctx, tx, `SELECT to_jsonb(r)||jsonb_build_object('task_id',c.task_id,'review_state',c.review_state,'comment_state',c.state) FROM comment_reports_v2 r JOIN task_comments_v2 c ON c.id=r.comment_id WHERE r.id=$1 AND c.subject_id IS NULL AND c.account_id=$2`, id, account)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("not_found", 404)
	}
	events, e := rows(ctx, tx, `SELECT to_jsonb(e) FROM comment_governance_events_v2 e WHERE e.report_id=$1 AND e.account_id=$2 AND e.erased_at IS NULL AND e.payload_text<>'' ORDER BY e.version`, id, account)
	if e != nil {
		return nil, e
	}
	own := []any{}
	for _, event := range events {
		p, e := parseObject(str(event, "payload_text"))
		if e != nil {
			return nil, e
		}
		own = append(own, Object{"eventId": event["id"], "kind": event["kind"], "version": event["version"], "at": isoValue(event["created_at"]), "summary": p["summary"]})
	}
	var pause, closed any
	if r["pause_until"] != nil {
		pause = isoValue(r["pause_until"])
	}
	if r["closed_at"] != nil {
		closed = isoValue(r["closed_at"])
	}
	return Object{"reportId": r["id"], "target": Object{"type": "task-comment", "id": r["comment_id"], "revision": r["comment_revision"]}, "taskId": r["task_id"], "version": r["version"], "state": r["state"], "pauseUntil": pause, "closedAt": closed, "reviewState": r["review_state"], "events": own, "canAppeal": r["state"] == "resolved" && num(r["appeal_count"]) < 3, "canSupplement": r["state"] != "withdrawn"}, nil
}
func (g *CommentGovernance) QueryAccount(ctx context.Context, a AccountCommentActor, input Object) (any, error) {
	if !exactFields(input, []string{"commentId"}, []string{"after", "limit"}) || !validID(str(input, "commentId")) {
		return nil, fail("invalid_comment_report_query", 400)
	}
	var after any
	if v, ok := input["after"]; ok {
		if !validID(text(v)) {
			return nil, fail("invalid_comment_report_query", 400)
		}
		after = v
	}
	limit := int64(10)
	if v, ok := input["limit"]; ok {
		if !validInt(v, 1, 30) {
			return nil, fail("invalid_comment_report_query", 400)
		}
		limit = num(v)
	}
	return g.accountRun(ctx, a, false, func(tx pgx.Tx) (any, error) {
		c, e := g.commentRow(ctx, tx, str(input, "commentId"), false)
		if e != nil {
			return nil, e
		}
		if c == nil || c["subject_id"] != nil || c["account_id"] != a.AccountID {
			return nil, fail("not_found", 404)
		}
		candidates, e := rows(ctx, tx, `SELECT jsonb_build_object('id',id) FROM comment_reports_v2 WHERE comment_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, input["commentId"], after, limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		var next any
		for i, r := range candidates {
			if int64(i) == limit {
				next = items[len(items)-1].(Object)["reportId"]
				break
			}
			v, e := g.accountViewWithin(ctx, tx, a.AccountID, str(r, "id"))
			if e != nil {
				return nil, e
			}
			items = append(items, v)
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
func (g *CommentGovernance) EventAccount(ctx context.Context, a AccountCommentActor, id, payloadJSON string) (any, error) {
	p, e := parseCommentGovernance(Envelope{PayloadJSON: payloadJSON}, false)
	if e != nil {
		return nil, e
	}
	kind := str(p, "kind")
	if str(p, "reportId") != id || !contains([]string{"appeal", "supplement"}, kind) {
		return nil, fail("invalid_comment_payload", 400)
	}
	return g.accountRun(ctx, a, true, func(tx pgx.Tx) (any, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "comment-governance:"+str(p, "id")); e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, `SELECT to_jsonb(e) FROM comment_governance_events_v2 e WHERE id=$1`, p["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["account_id"] != a.AccountID || prior["payload_hash"] != identity.Digest([]byte(payloadJSON)) {
				return nil, fail("comment_governance_conflict")
			}
			return Object{"reportId": prior["report_id"], "eventId": prior["id"], "version": prior["version"], "acknowledged": true}, nil
		}
		r, e := g.load(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		if r == nil || r["author_id"] != nil || r["author_account_id"] != a.AccountID {
			return nil, fail("not_found", 404)
		}
		if num(r["version"]) != num(p["expectedVersion"]) {
			return nil, fail("comment_governance_version_conflict")
		}
		if r["state"] == "withdrawn" {
			return nil, fail("comment_governance_transition")
		}
		appeals := num(r["appeal_count"])
		state := r["state"]
		closed := r["closed_at"]
		if kind == "appeal" {
			if state != "resolved" || appeals >= 3 {
				return nil, fail("comment_governance_transition")
			}
			state = "appealed"
			appeals++
			closed = nil
		}
		version := num(r["version"]) + 1
		if version > 100 {
			return nil, fail("comment_governance_event_limit", 413)
		}
		_, e = tx.Exec(ctx, `INSERT INTO comment_governance_events_v2(id,report_id,subject_id,account_id,version,kind,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,NULL,$3,$4,$5,NULL,$6,$7,$8)`, p["id"], id, a.AccountID, version, kind, payloadJSON, identity.Digest([]byte(payloadJSON)), stamp(g.now()))
		if e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `UPDATE comment_reports_v2 SET version=$2,state=$3,closed_at=$4,appeal_count=$5 WHERE id=$1`, id, version, state, closed, appeals)
		if e != nil {
			return nil, e
		}
		return Object{"reportId": id, "eventId": p["id"], "version": version, "state": state}, nil
	})
}
func (g *CommentGovernance) ReceiptAccount(ctx context.Context, a AccountCommentActor, id, hash string) (any, error) {
	if !validID(id) || !hashPattern.MatchString(hash) {
		return nil, fail("invalid_comment_receipt", 400)
	}
	return g.accountRun(ctx, a, false, func(tx pgx.Tx) (any, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "comment-governance:"+id); e != nil {
			return nil, e
		}
		r, e := row(ctx, tx, `SELECT to_jsonb(e) FROM comment_governance_events_v2 e WHERE id=$1`, id)
		if e != nil {
			return nil, e
		}
		if r == nil || r["account_id"] != a.AccountID {
			return Object{"state": "absent"}, nil
		}
		if r["payload_hash"] != hash {
			return Object{"state": "conflict"}, nil
		}
		return Object{"state": "acknowledged", "reportId": r["report_id"], "eventId": r["id"], "version": r["version"]}, nil
	})
}
