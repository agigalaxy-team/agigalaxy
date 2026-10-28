package chat

import (
	"context"
	"github.com/jackc/pgx/v5"
	"math/big"
)

func (s *Service) Cursor(ctx context.Context, a Actor, room string, raw []byte) (Object, error) {
	x, e := loose(raw)
	if e != nil {
		return nil, e
	}
	if _, ok := x["kind"]; !ok {
		x["kind"] = "human"
	}
	if !has([]string{"human", "agent"}, str(x, "kind")) || !digits.MatchString(str(x, "sequence")) || str(x, "kind") == "agent" && !validID(str(x, "agentGrantId")) || str(x, "kind") == "human" && x["agentGrantId"] != nil {
		return nil, fail("invalid_chat_request", 400)
	}
	if values, ok := x["visibleMessageIds"]; ok {
		ids, ok := values.([]any)
		if !ok || str(x, "kind") != "human" || len(ids) < 1 || len(ids) > 100 {
			return nil, fail("invalid_chat_request", 400)
		}
		for _, id := range ids {
			if !validID(asString(id)) {
				return nil, fail("invalid_chat_request", 400)
			}
		}
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx) (Object, error) {
		if _, e := s.requireRoom(ctx, tx, a, room, true, false); e != nil {
			return nil, e
		}
		if e = s.agent(ctx, tx, a, room, str(x, "agentGrantId"), false); e != nil {
			return nil, e
		}
		var max string
		if e = tx.QueryRow(ctx, "SELECT COALESCE(MAX(sequence),0)::text FROM chat_message_refs WHERE room_id=$1", room).Scan(&max); e != nil {
			return nil, e
		}
		sequence, _ := new(big.Int).SetString(str(x, "sequence"), 10)
		maximum, _ := new(big.Int).SetString(max, 10)
		if sequence.Cmp(maximum) > 0 {
			return nil, fail("chat_cursor_out_of_range")
		}
		ref, _ := actorRef(a)
		order := "0"
		if str(x, "kind") == "human" && x["visibleMessageIds"] != nil {
			ids := uniqueStrings(x["visibleMessageIds"])
			rr, e := s.messageRows(ctx, tx, a, room, "m.message_id=ANY($3::uuid[])", []any{ids}, "m.sequence ASC", 0)
			if e != nil {
				return nil, e
			}
			readable := []Object{}
			for _, r := range rr {
				n, _ := new(big.Int).SetString(str(r, "sequence"), 10)
				if s.visible(r) && str(r, "state") == "accepted" && n.Cmp(sequence) <= 0 {
					readable = append(readable, r)
				}
			}
			if len(readable) != len(ids) {
				return nil, fail("chat_message_unavailable")
			}
			for _, r := range readable {
				if _, e = tx.Exec(ctx, "INSERT INTO chat_human_message_reads(room_id,subject_id,message_id,read_at) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,subject_id,message_id) DO NOTHING", room, ref, r["message_id"], s.now()); e != nil {
					return nil, e
				}
			}
		} else if str(x, "kind") == "human" {
			if e = tx.QueryRow(ctx, "SELECT COALESCE(MAX(accepted_order),0)::text FROM chat_message_refs WHERE room_id=$1 AND sequence<=$2", room, str(x, "sequence")).Scan(&order); e != nil {
				return nil, e
			}
		}
		var recorded string
		e = tx.QueryRow(ctx, `INSERT INTO chat_cursors(room_id,subject_id,cursor_kind,agent_ref,sequence,accepted_order,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(room_id,subject_id,cursor_kind,agent_ref) DO UPDATE SET sequence=GREATEST(chat_cursors.sequence,$5),accepted_order=GREATEST(chat_cursors.accepted_order,$6),updated_at=$7 RETURNING sequence::text`, room, ref, x["kind"], str(x, "agentGrantId"), str(x, "sequence"), order, s.now()).Scan(&recorded)
		return Object{"kind": x["kind"], "sequence": recorded, "agentGrantId": x["agentGrantId"]}, e
	})
}
