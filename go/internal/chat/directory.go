package chat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

const directoryReadable = `m.state='accepted' AND m.expires_at>$4 AND NOT COALESCE(p.hidden,false) AND NOT ` + operationsBlocked + ` AND NOT (m.subject_id<>$2 AND EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=m.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased')))`
const directoryUnread = `m.actor_kind='human' AND m.subject_id<>$2 AND NOT EXISTS(SELECT 1 FROM chat_human_message_reads h WHERE h.room_id=m.room_id AND h.subject_id=$2 AND h.message_id=m.message_id) AND NOT EXISTS(SELECT 1 FROM chat_cursors c WHERE c.room_id=m.room_id AND c.subject_id=$2 AND c.cursor_kind='human' AND c.agent_ref='' AND m.sequence<=c.sequence AND m.accepted_order<=c.accepted_order)`

type directoryCursor struct {
	Version    int    `json:"version"`
	SubjectID  string `json:"subjectId"`
	Endpoint   string `json:"endpoint"`
	Watermark  string `json:"watermark"`
	AsOf       int64  `json:"asOf"`
	ExpiresAt  int64  `json:"expiresAt"`
	LastOrder  string `json:"lastOrder"`
	LastRoomID string `json:"lastRoomId"`
	Query      string `json:"query,omitempty"`
}

func (s *Service) Directory(ctx context.Context, a Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "cursor", "limit", "query")
	if e != nil {
		return nil, e
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(30)
	}
	if !normalizeInteger(x, "limit", 1, 100) {
		return nil, fail("invalid_chat_request", 400)
	}
	if v, ok := x["query"]; ok {
		value, ok := v.(string)
		if !ok || textLength(trim(value)) > 120 {
			return nil, fail("invalid_chat_request", 400)
		}
		x["query"] = trim(value)
	}
	if v, ok := x["cursor"]; ok && v != nil {
		value, ok := v.(string)
		if !ok || textLength(value) > 8192 {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	page, e := s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
		ref, _ := actorRef(a)
		var cursor directoryCursor
		var lastOrder any
		lastRoom := ""
		watermark := ""
		asOf, expires := s.now().Unix(), s.now().Unix()+900
		if str(x, "cursor") != "" {
			bytes, e := base64.RawURLEncoding.DecodeString(str(x, "cursor"))
			if e != nil || protocol.Decode(bytes, &cursor) != nil || cursor.Version != 1 || !digits.MatchString(cursor.Watermark) || !digits.MatchString(cursor.LastOrder) || !validID(cursor.LastRoomID) || cursor.AsOf <= 0 || cursor.ExpiresAt <= 0 || textLength(trim(cursor.Query)) > 120 || cursor.SubjectID != ref || cursor.Endpoint != s.Endpoint || trim(cursor.Query) != str(x, "query") {
				return nil, fail("invalid_chat_cursor", 400)
			}
			if cursor.ExpiresAt <= s.now().Unix() {
				return nil, fail("chat_directory_cursor_expired")
			}
			watermark, asOf, expires, lastOrder, lastRoom = cursor.Watermark, cursor.AsOf, cursor.ExpiresAt, cursor.LastOrder, cursor.LastRoomID
		} else if e = tx.QueryRow(ctx, "SELECT value::text FROM chat_directory_clock WHERE singleton=true").Scan(&watermark); e != nil {
			return nil, e
		}
		rr, e := rows(ctx, tx, `WITH candidates AS (SELECT r.room_id,COALESCE((SELECT MAX(q.accepted_order) FROM chat_message_refs q WHERE q.room_id=r.room_id AND q.accepted_order<=$2),r.created_order) AS sort_order FROM chat_rooms r JOIN chat_memberships m USING(room_id) WHERE m.subject_id=$1 AND m.left_at IS NULL AND r.created_order<=$2 AND m.joined_order<=$2 AND ($6::text='' OR position(lower($6) in lower(r.title))>0 OR EXISTS(SELECT 1 FROM chat_memberships other JOIN chat_participants_v3 participant ON participant.actor_ref=other.subject_id JOIN community_accounts account ON account.id=participant.account_id JOIN official_account_profiles_v1 profile ON profile.account_id=participant.account_id WHERE other.room_id=r.room_id AND other.left_at IS NULL AND (position(lower($6) in lower(COALESCE(profile.display_name,'')))>0 OR account.uid=upper($6))))) SELECT jsonb_build_object('room_id',room_id,'sort_order',sort_order::text) FROM candidates WHERE ($3::bigint IS NULL OR sort_order<$3 OR (sort_order=$3 AND room_id::text<$4)) ORDER BY sort_order DESC,room_id DESC LIMIT $5`, ref, watermark, lastOrder, lastRoom, num(x, "limit")+1, str(x, "query"))
		if e != nil {
			return nil, e
		}
		var next any
		if int64(len(rr)) > num(x, "limit") {
			rr = rr[:num(x, "limit")]
			last := rr[len(rr)-1]
			bytes, _ := json.Marshal(directoryCursor{1, ref, s.Endpoint, watermark, asOf, expires, str(last, "sort_order"), str(last, "room_id"), str(x, "query")})
			next = base64.RawURLEncoding.EncodeToString(bytes)
		}
		return Object{"rows": rr, "watermark": watermark, "nextCursor": next, "asOf": asOf}, nil
	})
	if e != nil {
		return nil, e
	}
	rooms := []Object{}
	for _, r := range page["rows"].([]Object) {
		result, e := s.run(ctx, a, false, false, func(tx pgx.Tx) (Object, error) {
			return s.directoryRoom(ctx, tx, a, str(r, "room_id"), str(page, "watermark"))
		})
		if e != nil {
			if has([]string{"chat_access_denied", "chat_room_not_found"}, fault.Code(e)) {
				continue
			}
			return nil, e
		}
		rooms = append(rooms, result)
	}
	return Object{"rooms": rooms, "nextCursor": page["nextCursor"], "asOf": page["asOf"]}, nil
}
func (s *Service) directoryRoom(ctx context.Context, tx pgx.Tx, a Actor, room, watermark string) (Object, error) {
	c, e := s.requireRoom(ctx, tx, a, room, true, false)
	if e != nil {
		return nil, e
	}
	base := s.view(c)
	base["humanReadSequence"] = "0"
	base["readExpiresAt"] = s.now().Unix() + 60
	activity, e := row(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT sent_at,accepted_at FROM chat_message_refs WHERE room_id=$1 AND accepted_order<=$2 ORDER BY accepted_order DESC LIMIT 1)q", room, watermark)
	if e != nil {
		return nil, e
	}
	base["lastActivityAt"] = iso(c.Room["created_at"])
	base["activityTimeBasis"] = "room-created"
	if activity != nil {
		base["lastActivityAt"] = iso(activity["sent_at"])
		base["activityTimeBasis"] = "legacy-sent-time"
		if activity["accepted_at"] != nil {
			base["lastActivityAt"] = iso(activity["accepted_at"])
			base["activityTimeBasis"] = "accepted-time"
		}
	}
	projected := false
	ref, _ := actorRef(a)
	metadata := func(rr []Object) ([]Object, error) {
		if !projected {
			if e := s.project(ctx, c); e != nil {
				return nil, e
			}
			projected = true
		}
		ids := []string{}
		for _, r := range rr {
			ids = append(ids, str(r, "archive_id"))
		}
		result, e := s.command(ctx, "read", Object{"roomId": room, "subjectId": ref, "ids": ids, "roomRevision": c.Room["revision"], "metadataOnly": true})
		if e != nil {
			return nil, e
		}
		items, ok := result["messages"].([]any)
		if !ok {
			return nil, fail("chat_transport_invalid_reply", 502)
		}
		found := map[string]Object{}
		for _, item := range items {
			body, ok := item.(map[string]any)
			if !ok {
				return nil, fail("chat_transport_invalid_reply", 502)
			}
			found[str(body, "archiveId")] = body
		}
		out := []Object{}
		for _, r := range rr {
			if body := found[str(r, "archive_id")]; body != nil && num(body, "revision") == num(r, "revision") {
				out = append(out, r)
			}
		}
		return out, nil
	}
	candidates := func(before any, limit int64, unread bool) ([]Object, error) {
		condition := "m.accepted_order<=$3 AND " + directoryReadable + " AND ($5::bigint IS NULL OR m.accepted_order<$5)"
		if unread {
			condition += " AND " + directoryUnread
		}
		return s.messageRows(ctx, tx, a, room, condition, []any{watermark, s.now(), before}, "m.accepted_order DESC", limit)
	}
	read := func() (Object, error) {
		var latest Object
		var before any
		for latest == nil {
			rr, e := candidates(before, 20, false)
			if e != nil {
				return nil, e
			}
			if len(rr) == 0 {
				break
			}
			available, e := metadata(rr)
			if e != nil {
				return nil, e
			}
			for _, r := range available {
				reading, e := s.readMessages(ctx, tx, a, c, []Object{r}, Object{}, true)
				if e != nil {
					return nil, e
				}
				messages := reading["messages"].([]Object)
				if len(messages) > 0 {
					latest = messages[0]
					base["readExpiresAt"] = reading["readExpiresAt"]
					break
				}
			}
			before = rr[len(rr)-1]["accepted_order"]
		}
		if latest != nil && str(latest, "text") != "" {
			text := []rune(str(latest, "text"))
			latest["excerptTruncated"] = len(text) > 300
			if len(text) > 300 {
				latest["text"] = string(text[:300])
			}
		}
		verified := []string{}
		before = nil
		for {
			rr, e := candidates(before, 100, true)
			if e != nil {
				return nil, e
			}
			if len(rr) == 0 {
				break
			}
			available, e := metadata(rr)
			if e != nil {
				return nil, e
			}
			for _, r := range available {
				verified = append(verified, str(r, "message_id"))
			}
			before = rr[len(rr)-1]["accepted_order"]
		}
		count, e := row(ctx, tx, `SELECT to_jsonb(q) FROM (SELECT count(*)::int AS count,MIN(m.expires_at) AS expires_at FROM chat_message_refs m LEFT JOIN chat_message_preferences p ON p.message_id=m.message_id AND p.subject_id=$2 WHERE m.room_id=$1 AND m.accepted_order<=$3 AND `+directoryReadable+` AND `+directoryUnread+` AND m.message_id=ANY($5::uuid[]))q`, room, ref, watermark, s.now(), verified)
		if e != nil {
			return nil, e
		}
		current, e := row(ctx, tx, "SELECT jsonb_build_object('sequence',sequence::text) FROM chat_cursors WHERE room_id=$1 AND subject_id=$2 AND cursor_kind='human' AND agent_ref=''", room, ref)
		if e != nil {
			return nil, e
		}
		if current != nil {
			base["humanReadSequence"] = current["sequence"]
		}
		if latest != nil {
			rr, e := s.messageRows(ctx, tx, a, room, "m.message_id=$3", []any{latest["messageId"]}, "m.sequence ASC", 0)
			if e != nil {
				return nil, e
			}
			if len(rr) == 0 || !s.visible(rr[0]) || str(rr[0], "state") != "accepted" || num(rr[0], "revision") != num(latest, "revision") {
				latest = nil
			}
		}
		if count["expires_at"] != nil && sec(count["expires_at"]) < num(base, "readExpiresAt") {
			base["readExpiresAt"] = sec(count["expires_at"])
		}
		base["latestMessage"] = latest
		base["unreadHumanCount"] = count["count"]
		return base, nil
	}
	result, e := read()
	if e == nil {
		return result, nil
	}
	if fault.Code(e) == "internal_error" {
		return nil, e
	}
	base["latestMessage"] = nil
	base["unreadHumanCount"] = nil
	base["contentUnavailableReason"] = fault.Code(e)
	return base, nil
}
