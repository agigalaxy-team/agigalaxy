package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

// NotificationReadWithin supplies the original current Task event notice. The
// Inbox caller already holds current notifications scope in this transaction.
func (s *Service) NotificationReadWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, candidate Object) (Object, error) {
	id := str(candidate, "task_id")
	task, e := s.RequireTaskWithin(ctx, tx, &a, id, false)
	if e != nil {
		return nil, e
	}
	event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM task_events e WHERE id=$1", candidate["event_id"])
	if e != nil || event == nil {
		return nil, e
	}
	grant, e := s.grant(ctx, tx, event)
	if e != nil {
		return nil, e
	}
	if !s.visible(grant, a.SubjectID) {
		return nil, nil
	}
	payload, e := parseObject(str(event, "payload_text"))
	if e != nil {
		return nil, e
	}
	input := obj(payload, "event")
	if event["kind"] == "invite" && (input["recipientId"] != a.SubjectID || contains(stringsOf(obj(task, "governance")["scopes"]), "new-participation-paused")) {
		return nil, nil
	}
	current, e := s.ReadTaskWithin(ctx, tx, &a, id)
	if e != nil {
		return nil, e
	}
	out := Object{"title": obj(current, "request")["title"], "eventKind": event["kind"], "actorId": event["subject_id"], "object": Object{"type": "task", "id": event["task_id"], "eventId": event["id"]}, "serviceReceipt": contains([]string{"dispute", "confirm-resolution", "propose-resolution"}, str(event, "kind"))}
	if textView := obj(current, "textView"); textView != nil {
		out["textView"] = Object{"title": obj(textView, "fields")["title"]}
	}
	return out, nil
}
func (c *CommentService) NotificationReadWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, candidate Object) (Object, error) {
	return c.NotificationViewWithin(ctx, tx, a, str(candidate, "event_id"))
}
func (g *CommentGovernance) NotificationReadWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, candidate Object) (Object, error) {
	return g.NotificationViewWithin(ctx, tx, a, str(candidate, "event_id"), str(candidate, "task_id"))
}

func (s *Service) LegacyNotificationReadWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, candidate Object) (Object, error) {
	loaded, e := s.LegacyLoadWithin(ctx, tx, str(candidate, "assistance_id"), true)
	if e != nil {
		return nil, e
	}
	var event Object
	for _, row := range loaded.Events {
		if row["id"] == candidate["event_id"] {
			event = row
			break
		}
	}
	if event == nil || event["subject_id"] == a.SubjectID || !s.visible(loaded.Grants[str(loaded.Row, "id")], a.SubjectID) || !s.visible(loaded.Grants[str(event, "id")], a.SubjectID) {
		return nil, nil
	}
	payload, e := parseObject(str(event, "payload_text"))
	if e != nil {
		return nil, e
	}
	input := obj(payload, "event")
	if input == nil || input["kind"] == "shortlist" {
		return nil, nil
	}
	var summary any
	for _, key := range []string{"note", "summary", "reason"} {
		if value, ok := input[key]; ok && value != nil {
			summary = value
			break
		}
	}
	return Object{"title": obj(obj(loaded.Row, "snapshot"), "request")["title"], "eventKind": input["kind"], "actorId": event["subject_id"], "summary": summary}, nil
}
