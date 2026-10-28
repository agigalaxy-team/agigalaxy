package community

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
	"unicode/utf16"
)

func preview(value string) any {
	units := utf16.Encode([]rune(value))
	if len(units) <= 180 {
		return value
	}
	units = units[:180]
	if last := units[len(units)-1]; last >= 0xd800 && last <= 0xdbff {
		head := encode(string(utf16.Decode(units[:179])))
		return json.RawMessage(append(head[:len(head)-1], []byte(fmt.Sprintf(`\u%04x"`, last))...))
	}
	return string(utf16.Decode(units))
}
func (s *Service) notice(ctx context.Context, tx pgx.Tx, account, id string) (Object, error) {
	r, e := row(ctx, tx, `SELECT to_jsonb(r)||jsonb_build_object('read_at',n.read_at) FROM forum_replies_v1 r JOIN forum_posts_v1 p ON p.id=r.post_id LEFT JOIN forum_replies_v1 parent ON parent.id=r.reply_to_id LEFT JOIN forum_notification_reads_v2 n ON n.account_id=$2 AND n.reply_id=r.id WHERE r.id=$1 AND (p.account_id=$2 OR parent.account_id=$2) AND r.account_id IS DISTINCT FROM $2::uuid`, id, account)
	if e != nil || r == nil {
		return nil, e
	}
	view, e := s.readReply(ctx, tx, id, account)
	if e != nil {
		return nil, e
	}
	if str(view, "availability") != "available" {
		return nil, nil
	}
	post, e := s.readVersion(ctx, tx, str(r, "post_id"), str(r, "post_version_id"), account)
	if e != nil {
		return nil, e
	}
	if str(post, "availability") != "available" {
		return nil, nil
	}
	out, e := s.author(ctx, tx, r)
	if e != nil {
		return nil, e
	}
	until := num(view, "publishedUntil")
	if n := num(post, "publishedUntil"); n < until {
		until = n
	}
	for k, v := range (Object{"replyId": r["id"], "postId": r["post_id"], "postVersionId": r["post_version_id"], "title": obj(post, "payload")["title"], "preview": preview(str(obj(view, "payload"), "body")), "at": stamp(time.Unix(seconds(r["created_at"]), 0)), "read": r["read_at"] != nil, "sourceExpiresAt": stamp(time.Unix(until, 0))}) {
		out[k] = v
	}
	return out, nil
}
func (s *Service) Notifications(ctx context.Context, account string, raw []byte) (Object, error) {
	q, limit, e := queryInput(raw, "after", "limit", "unreadOnly")
	if e != nil {
		return nil, e
	}
	if v, ok := q["after"]; ok && !validID(asString(v)) {
		return nil, invalid()
	}
	if v, ok := q["unreadOnly"]; ok {
		if _, ok = v.(bool); !ok {
			return nil, invalid()
		}
	}
	return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		if s.actor != nil && account == "" {
			a, e := s.resolveIdentityAccount(ctx, tx, "", false)
			if e != nil {
				return nil, e
			}
			account = str(a, "id")
		}
		rr, e := rows(ctx, tx, `SELECT jsonb_build_object('id',r.id) FROM forum_replies_v1 r JOIN forum_posts_v1 p ON p.id=r.post_id LEFT JOIN forum_replies_v1 parent ON parent.id=r.reply_to_id LEFT JOIN forum_notification_reads_v2 n ON n.account_id=$1 AND n.reply_id=r.id WHERE (p.account_id=$1 OR parent.account_id=$1) AND r.account_id IS DISTINCT FROM $1::uuid AND r.state='published' AND r.published_until>$2 AND ($3::uuid IS NULL OR r.id>$3) AND (NOT $4::boolean OR n.reply_id IS NULL) ORDER BY r.id LIMIT 201`, account, s.now(), q["after"], truth(q, "unreadOnly"))
		if e != nil {
			return nil, e
		}
		items := []Object{}
		processed := 0
		var scanned any
		for _, r := range rr {
			if processed == 200 {
				break
			}
			processed++
			scanned = r["id"]
			notice, e := s.notice(ctx, tx, account, str(r, "id"))
			if e != nil {
				return nil, e
			}
			if notice != nil {
				items = append(items, notice)
			}
			if int64(len(items)) == limit {
				break
			}
		}
		more := processed < len(rr)
		var next any
		if more {
			next = scanned
		}
		return Object{"items": items, "nextAfter": next, "scanTruncated": more && processed == 200 && int64(len(items)) < limit, "checkedAt": s.clock()}, nil
	})
}
func (s *Service) MarkNotificationRead(ctx context.Context, account string, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || !strict(q, "replyId") || !validID(str(q, "replyId")) {
		return nil, invalid()
	}
	return s.runWrite(ctx, account, true, func(tx pgx.Tx) (Object, error) {
		if account == "" && s.actor == nil {
			return nil, fail("official_account_login_required", 401)
		}
		if s.actor != nil && account == "" {
			a, e := s.resolveIdentityAccount(ctx, tx, "", false)
			if e != nil {
				return nil, e
			}
			account = str(a, "id")
		}
		notice, e := s.notice(ctx, tx, account, str(q, "replyId"))
		if e != nil {
			return nil, e
		}
		if notice == nil {
			return nil, fail("not_found", 404)
		}
		_, e = tx.Exec(ctx, "INSERT INTO forum_notification_reads_v2(account_id,reply_id,read_at) VALUES($1,$2,$3) ON CONFLICT(account_id,reply_id) DO NOTHING", account, q["replyId"], s.now())
		if e != nil {
			return nil, e
		}
		return Object{"replyId": q["replyId"], "read": true, "checkedAt": s.clock()}, nil
	})
}
