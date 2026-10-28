package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) MaintenanceReadiness(ctx context.Context) (Object, error) {
	probe, ok := s.Transport.(interface {
		Probe(context.Context) (Object, error)
	})
	if !ok {
		return nil, fail("chat_transport_unavailable", 503)
	}
	return probe.Probe(ctx)
}

// PurgeExpired and EraseSubject are trusted worker/lifecycle consumers only.
// They are never dispatched through an end-user chat HTTP route.
func (s *Service) PurgeExpired(ctx context.Context, limit int) (Object, error) {
	if limit < 1 || limit > 1000 {
		return nil, fail("invalid_chat_request", 400)
	}
	if _, e := s.Pool.Exec(ctx, "UPDATE chat_message_refs SET state='expired',purge_pending=true WHERE expires_at<=$1 AND state IN ('pending','accepted')", s.now()); e != nil {
		return nil, e
	}
	if _, e := s.Pool.Exec(ctx, "UPDATE chat_rooms SET state='archived',revision=revision+1 WHERE state='owner-succession' AND succession_expires_at<=$1", s.now()); e != nil {
		return nil, e
	}
	rr, e := s.Pool.Query(ctx, "SELECT message_id::text FROM chat_message_refs WHERE purge_pending=true ORDER BY expires_at LIMIT $1", limit)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rr.Next() {
		var id string
		if e = rr.Scan(&id); e != nil {
			rr.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rr.Err()
	rr.Close()
	if e != nil {
		return nil, e
	}
	for _, id := range ids {
		if e = s.PurgeOne(ctx, id); e != nil {
			return nil, e
		}
	}
	return Object{"archiveDeleted": len(ids)}, nil
}
func (s *Service) EraseSubject(ctx context.Context, subject string, limit int) (Object, error) {
	if !subjectPattern.MatchString(subject) || limit < 1 || limit > 1000 {
		return nil, fail("invalid_chat_request", 400)
	}
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		rr, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM chat_rooms r JOIN chat_memberships m USING(room_id) WHERE m.subject_id=$1 AND m.left_at IS NULL ORDER BY r.room_id FOR UPDATE OF r`, subject)
		if e != nil {
			return nil, e
		}
		for _, r := range rr {
			if _, e = tx.Exec(ctx, "UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2", r["room_id"], subject, s.now()); e != nil {
				return nil, e
			}
			members, e := s.members(ctx, tx, str(r, "room_id"))
			if e != nil {
				return nil, e
			}
			parties := []string{}
			for _, m := range members {
				party := str(m, "controller_ref")
				if !has(parties, party) {
					parties = append(parties, party)
				}
			}
			state := str(r, "state")
			if len(parties) == 0 {
				state = "archived"
			} else if str(r, "owner_subject_id") == subject {
				state = "owner-succession"
			} else if len(parties) == 1 && str(r, "mode") == "ownerless" && truth(r, "had_multiple") {
				state = "single-member-decision"
			}
			admins := []string{}
			for _, id := range uniqueStrings(r["administrator_ids"]) {
				if id != subject {
					admins = append(admins, id)
				}
			}
			if _, e = tx.Exec(ctx, `UPDATE chat_rooms SET state=$2,revision=revision+1,member_revision=member_revision+1,updated_at=$3,administrator_ids=$5,succession_expires_at=CASE WHEN $2='owner-succession' AND state<>'owner-succession' THEN $4 ELSE succession_expires_at END WHERE room_id=$1`, r["room_id"], state, s.now(), s.now().Add(7*24*time.Hour), encode(admins)); e != nil {
				return nil, e
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE chat_agent_grants SET revoked_at=$2 WHERE subject_id=$1 AND revoked_at IS NULL", subject, s.now()); e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, "UPDATE chat_message_refs SET state='retracted',purge_pending=true,retracted_at=COALESCE(retracted_at,$2) WHERE subject_id=$1 AND state IN ('pending','accepted')", subject, s.now())
		return Object{}, e
	})
	if e != nil {
		return nil, e
	}
	rr, e := s.Pool.Query(ctx, "SELECT message_id::text FROM chat_message_refs WHERE subject_id=$1 AND purge_pending=true ORDER BY sequence LIMIT $2", subject, limit)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rr.Next() {
		var id string
		if e = rr.Scan(&id); e != nil {
			rr.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rr.Err()
	rr.Close()
	if e != nil {
		return nil, e
	}
	deleted := 0
	for _, id := range ids {
		if e = s.PurgeOne(ctx, id); e != nil {
			if fault.Code(e) == "internal_error" {
				return nil, e
			}
			break
		}
		deleted++
	}
	var pending int64
	if e = s.Pool.QueryRow(ctx, "SELECT count(*) FROM chat_message_refs WHERE subject_id=$1 AND purge_pending=true", subject).Scan(&pending); e != nil {
		return nil, e
	}
	return Object{"subjectId": subject, "archiveDeleted": deleted, "pendingArchiveDeletes": pending, "complete": pending == 0, "agentGrantsRevoked": true, "membershipsLeft": true, "othersMessagesDeleted": false}, nil
}
func (s *Service) ExportOwned(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := loose(raw)
	if e != nil {
		return nil, e
	}
	if _, ok := x["after"]; !ok {
		x["after"] = "0"
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(100)
	}
	if !digits.MatchString(str(x, "after")) || !normalizeInteger(x, "limit", 1, 100) {
		return nil, fail("invalid_chat_request", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		ref, _ := actorRef(a)
		rr, e := rows(ctx, tx, "SELECT to_jsonb(m)||jsonb_build_object('sequence',m.sequence::text) FROM chat_message_refs m WHERE m.subject_id=$1 AND m.sequence>$2 AND m.state='accepted' AND m.expires_at>$3 AND NOT "+operationsBlocked+" ORDER BY m.sequence LIMIT $4", ref, x["after"], s.now(), num(x, "limit")+1)
		if e != nil {
			return nil, e
		}
		messages := []Object{}
		for i, r := range rr {
			if int64(i) >= num(x, "limit") {
				break
			}
			result, e := s.command(ctx, "export-own", Object{"roomId": r["room_id"], "subjectId": ref, "ids": []string{str(r, "archive_id")}})
			if e != nil {
				return nil, e
			}
			items, ok := result["messages"].([]any)
			if !ok {
				return nil, fail("chat_transport_invalid_reply", 502)
			}
			current, e := row(ctx, tx, "SELECT to_jsonb(m) FROM chat_message_refs m WHERE message_id=$1 AND subject_id=$2", r["message_id"], ref)
			if e != nil {
				return nil, e
			}
			if current == nil || str(current, "state") != "accepted" || num(current, "revision") != num(r, "revision") || millis(current["expires_at"]) <= s.now().UnixMilli() || len(items) == 0 {
				continue
			}
			var blocked bool
			if e = tx.QueryRow(ctx, "SELECT "+operationsBlocked+" FROM chat_message_refs m WHERE message_id=$1", r["message_id"]).Scan(&blocked); e != nil {
				return nil, e
			}
			body, _ := items[0].(map[string]any)
			if blocked || body == nil || body["revision"] != nil && num(body, "revision") != num(r, "revision") {
				continue
			}
			out := s.receipt(current)
			out["roomId"] = r["room_id"]
			out["sequence"] = r["sequence"]
			out["text"] = body["text"]
			messages = append(messages, out)
		}
		var next any
		if int64(len(rr)) > num(x, "limit") {
			next = rr[num(x, "limit")-1]["sequence"]
		}
		return Object{"messages": messages, "next": next, "scope": "own-authored-retained-messages"}, nil
	})
}
