package qualification

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func (s *Service) QueryRequests(ctx context.Context, a Actor, input Object) (any, error) {
	if !queryClosed(input, nil, []string{"view", "taskId", "after", "limit"}) {
		return requestInvalid()
	}
	view := "received"
	if v, ok := input["view"]; ok {
		view = text(v)
	}
	if view != "sent" && view != "received" {
		return requestInvalid()
	}
	var taskID, after any
	for _, key := range []string{"taskId", "after"} {
		if v, ok := input[key]; ok {
			if !uuidPattern.MatchString(text(v)) {
				return requestInvalid()
			}
			if key == "taskId" {
				taskID = v
			} else {
				after = v
			}
		}
	}
	limit := int64(12)
	if v, ok := input["limit"]; ok {
		if !positiveInteger(v) || number(v) > 30 {
			return requestInvalid()
		}
		limit = number(v)
	}
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) {
		column := "source_author_id"
		if view == "sent" {
			column = "subject_id"
		}
		rows, e := readRows(ctx, tx, "SELECT jsonb_build_object('id',id) FROM qualification_permission_requests WHERE "+column+"=$1 AND ($2::uuid IS NULL OR task_id=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", a.SubjectID, taskID, after, limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, row := range rows[:min(len(rows), int(limit))] {
			item, e := s.ReadRequestWithin(ctx, tx, a.Actor, Object{"requestId": row["id"]})
			if e != nil {
				return nil, e
			}
			items = append(items, item)
		}
		var next any
		if int64(len(rows)) > limit {
			next = object(items[len(items)-1])["requestId"]
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}

// NotificationReadWithin projects only the request's currently visible event;
// Inbox already owns its actual notifications transaction and presentation state.
func (s *Service) NotificationReadWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, candidate Object) (Object, error) {
	if s.Devices == nil || s.Assistance == nil {
		return nil, fail("qualification_unavailable", 503)
	}
	if e := s.Devices.AuthorizeWithin(ctx, tx, a, "notifications"); e != nil {
		return nil, e
	}
	row, e := readRow(ctx, tx, "SELECT jsonb_build_object('request_id',request_id) FROM qualification_permission_request_events WHERE id=$1", candidate["event_id"])
	if e != nil || row == nil {
		return nil, e
	}
	view, e := s.ReadRequestWithin(ctx, tx, a, Object{"requestId": row["request_id"]})
	if e != nil {
		return nil, e
	}
	for _, v := range array(view["history"]) {
		event := object(v)
		if event["eventId"] == candidate["event_id"] {
			return Object{"title": "限定资格计算许可事项", "eventKind": "qualification-permission-" + str(event, "kind"), "actorId": event["by"], "object": Object{"type": "qualification-request", "id": row["request_id"]}, "sourceExpiresAt": view["expiresAt"], "serviceReceipt": event["kind"] != "request"}, nil
		}
	}
	return nil, nil
}
