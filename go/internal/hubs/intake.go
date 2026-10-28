package hubs

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("hubReceiptSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		r, e := one(ctx, tx, "SELECT * FROM hub_events_v2 WHERE id=$1 AND subject_id=$2", in["operationId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return Object{"operationId": in["operationId"], "state": "absent"}, nil
		}
		if r["payload_hash"] != in["payloadHash"] {
			return nil, fault.New("hub_receipt_conflict", 409)
		}
		return receipt(r), nil
	})
}
func (s *Service) Intake(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("hubIntakeQuerySchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		h, e := s.head(ctx, tx, txt(in, "hubId"), false)
		if e != nil {
			return nil, e
		}
		limit := num(in, "limit")
		rows, e := query(ctx, tx, "SELECT * FROM hub_intake_v2 WHERE hub_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR id>$3) AND (subject_id=$4 OR $4=$5) ORDER BY id LIMIT $6", h["id"], in["threadId"], in["after"], a.SubjectID, h["owner_id"], limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for i, thread := range rows {
			if int64(i) >= limit {
				break
			}
			events, e := query(ctx, tx, "SELECT * FROM hub_events_v2 WHERE hub_id=$1 AND object_id=$2 ORDER BY object_version", h["id"], thread["id"])
			if e != nil {
				return nil, e
			}
			messages := []any{}
			for _, row := range events {
				readable := false
				if num(thread, "expires_at") > s.now() {
					readable, e = s.readable(ctx, tx, &a, row)
					if e != nil {
						return nil, e
					}
				}
				payload := Object(nil)
				if readable {
					payload = event(row)
				}
				message := Object{"id": row["id"], "authorId": row["subject_id"], "kind": row["kind"], "version": row["object_version"], "contentAvailable": payload != nil, "receivedAt": row["received_at"]}
				if payload != nil {
					if title, ok := payload["title"]; ok {
						message["title"] = title
					}
					message["text"] = payload["text"]
				}
				messages = append(messages, message)
			}
			actions := []any{}
			if thread["state"] == "open" && num(thread, "expires_at") > s.now() {
				actions = append(actions, "intake-reply", "intake-close")
			}
			items = append(items, Object{"threadId": thread["id"], "hubId": h["id"], "version": thread["version"], "state": thread["state"], "expiresAt": thread["expires_at"], "availableActions": actions, "messages": messages})
		}
		return Object{"items": items, "nextCursor": cursor(rows, limit), "externalServiceResponseGuarantee": false}, nil
	})
}
func (s *Service) PurgeExpired(ctx context.Context, limit int) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("hub_service_unavailable", 503)
	}
	if limit < 0 {
		return nil, fault.New("invalid_hub_request", 400)
	}
	rows, e := s.Pool.Query(ctx, "SELECT id::text FROM hub_intake_v2 WHERE expires_at<=$1 ORDER BY id LIMIT $2", s.now(), limit)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	for _, id := range ids {
		if _, e = s.Pool.Exec(ctx, "UPDATE hub_events_v2 SET payload_text='' WHERE object_id=$1 AND kind IN ('intake-open','intake-reply','intake-close')", id); e != nil {
			return nil, e
		}
	}
	return Object{"processed": len(ids), "scope": "expired-intake-content-only"}, nil
}
