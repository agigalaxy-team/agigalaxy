package taskmaterials

import (
	"context"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func (c *CommentService) Query(ctx context.Context, a *Actor, input Object) (any, error) {
	if !exactFields(input, []string{"taskId"}, []string{"after", "limit", "query"}) || !validID(str(input, "taskId")) {
		return nil, fail("invalid_comment_query", 400)
	}
	after := ""
	if value, ok := input["after"]; ok {
		after = text(value)
		if !validID(after) {
			return nil, fail("invalid_comment_query", 400)
		}
	}
	limit := int64(20)
	if value, ok := input["limit"]; ok {
		if !validInt(value, 1, 50) {
			return nil, fail("invalid_comment_query", 400)
		}
		limit = num(value)
	}
	query := ""
	if value, ok := input["query"]; ok {
		var valid bool
		query, valid = value.(string)
		if !valid {
			return nil, fail("invalid_comment_query", 400)
		}
		query = jsTrim(query)
		if protocol.TextLength(query) > 120 {
			return nil, fail("invalid_comment_query", 400)
		}
	}
	run := func(tx pgx.Tx) (any, error) {
		var actor *deviceauth.Actor
		if a != nil {
			actor = &a.Actor
		}
		if _, e := c.RequireTaskWithin(ctx, tx, actor, str(input, "taskId"), false); e != nil {
			return nil, e
		}
		var cursor any
		if after != "" {
			cursor = after
		}
		candidates, e := rows(ctx, tx, "SELECT jsonb_build_object('id',id) FROM task_comments_v2 WHERE task_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 200", input["taskId"], cursor)
		if e != nil {
			return nil, e
		}
		items := []any{}
		var next any
		lower := cases.Lower(language.Und)
		for _, candidate := range candidates {
			next = candidate["id"]
			view, e := c.ReadWithin(ctx, tx, actor, str(candidate, "id"), 0, false)
			if e != nil {
				return nil, e
			}
			if query == "" || strings.Contains(lower.String(commentBodyFromView(view["body"]).decoded()), lower.String(query)) && view["body"] != nil {
				items = append(items, view)
			}
			if int64(len(items)) == limit {
				break
			}
		}
		if int64(len(items)) != limit && len(candidates) != 200 {
			next = nil
		}
		return Object{"items": items, "nextAfter": next, "authority": "current-task-comments", "taskStateChanged": false}, nil
	}
	if a == nil {
		return postgres.InTx(ctx, c.Pool, run)
	}
	return c.run(ctx, *a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) { return run(tx) })
}

// NotificationViewWithin contains only current source-qualified locator data.
// The Inbox owner supplies candidate discovery and delivery qualification.
func (c *CommentService) NotificationViewWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, eventID string) (Object, error) {
	event, e := c.commentEvent(ctx, tx, eventID)
	if e != nil || event == nil {
		return nil, e
	}
	current, e := c.commentRow(ctx, tx, str(event, "comment_id"), false)
	if e != nil || current == nil {
		return nil, e
	}
	if current["current_event_id"] != event["id"] {
		return nil, nil
	}
	view, e := c.ReadWithin(ctx, tx, &a, str(event, "comment_id"), 0, false)
	if e != nil {
		return nil, e
	}
	if view["body"] == nil {
		return nil, nil
	}
	return Object{"title": "任务评论有更新", "eventKind": event["kind"], "actorId": event["subject_id"], "object": Object{"type": "task-comment", "id": event["comment_id"], "taskId": event["task_id"], "revision": event["revision"]}, "sourceExpiresAt": view["expiresAt"], "serviceReceipt": false}, nil
}
