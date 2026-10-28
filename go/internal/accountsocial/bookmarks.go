package accountsocial

import (
	"context"
	"encoding/base64"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func tables(account bool) (string, string, string, int64, int64) {
	if account {
		return "account_reading_bookmarks_v2", "account_reading_bookmark_operations_v2", "account_id", 839179, 839180
	}
	return "reading_bookmarks_v1", "reading_bookmark_operations_v1", "subject_id", 839177, 839178
}
func ownerID(a Actor, account bool) string {
	if account {
		return a.AccountID
	}
	return a.Device.SubjectID
}
func bookmarkState(ref Reference, r Object) Object {
	out := Object{"reference": ref, "saved": false, "revision": 0}
	if r != nil {
		out["saved"] = r["saved"]
		out["revision"] = r["revision"]
		out["id"] = r["id"]
		out["savedAt"] = date(r["saved_at"])
	}
	return out
}
func bookmarkStatus(ctx context.Context, tx pgx.Tx, owner string, ref Reference, account bool) (Object, error) {
	table, _, column, _, _ := tables(account)
	r, e := row(ctx, tx, `SELECT * FROM `+table+` WHERE `+column+`=$1 AND reference_key=$2`, owner, ref.Key())
	if e != nil {
		return nil, e
	}
	return bookmarkState(ref, r), nil
}
func bookmarkReceipt(ctx context.Context, tx pgx.Tx, owner, id, hash string, account bool) (Object, error) {
	_, table, column, _, _ := tables(account)
	r, e := row(ctx, tx, `SELECT request_hash,result FROM `+table+` WHERE `+column+`=$1 AND operation_id=$2`, owner, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return Object{"state": "absent", "operationId": id, "payloadHash": hash}, nil
	}
	if r["request_hash"] != hash {
		return nil, fault.New("reading_bookmark_operation_conflict", 409)
	}
	return object(r, "result"), nil
}
func (s *Service) Bookmark(ctx context.Context, a Actor, account bool, method string, raw []byte) (Object, error) {
	p, e := parse(raw, method, false, account)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, account, method == "command", func(tx pgx.Tx, a Actor) (Object, error) {
		owner := ownerID(a, account)
		switch method {
		case "status":
			ref, _ := reference(p["reference"])
			return bookmarkStatus(ctx, tx, owner, ref, account)
		case "receipt":
			return bookmarkReceipt(ctx, tx, owner, str(p, "operationId"), str(p, "payloadHash"), account)
		case "query":
			return s.bookmarkQuery(ctx, tx, a, account, p)
		case "command":
			ref, _ := reference(p["reference"])
			cmd := bookmarkCommand{str(p, "operationId"), ref, p["saved"].(bool), num(p, "expectedRevision")}
			hash := identity.Digest(encode(cmd))
			table, operations, column, opLock, refLock := tables(account)
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, owner+":"+cmd.OperationID, opLock); e != nil {
				return nil, e
			}
			prior, e := bookmarkReceipt(ctx, tx, owner, cmd.OperationID, hash, account)
			if e != nil {
				return nil, e
			}
			if prior["state"] == "acknowledged" {
				return prior, nil
			}
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, owner+":"+ref.Key(), refLock); e != nil {
				return nil, e
			}
			r, e := row(ctx, tx, `SELECT * FROM `+table+` WHERE `+column+`=$1 AND reference_key=$2 FOR UPDATE`, owner, ref.Key())
			if e != nil {
				return nil, e
			}
			saved := r != nil && r["saved"] == true
			if num(r, "revision") != cmd.ExpectedRevision && saved != cmd.Saved {
				return nil, fault.New("reading_bookmark_changed", 409)
			}
			check := cmd.Saved && r == nil
			if account {
				check = cmd.Saved && !saved
			}
			if check {
				source := s.source(ctx, tx, a, ref)
				if source["state"] != "available" {
					if source["state"] == "temporarily-unavailable" {
						return nil, fault.New("reading_bookmark_reader_unavailable", 503)
					}
					return nil, fault.New("reading_bookmark_source_unavailable", 404)
				}
			}
			if r == nil || saved != cmd.Saved {
				id := uuid.NewString()
				if r != nil {
					id = str(r, "id")
				}
				if account {
					var subject any
					if !a.Official {
						subject = a.Device.SubjectID
					}
					_, e = tx.Exec(ctx, `INSERT INTO account_reading_bookmarks_v2(id,account_id,origin_subject_id,reference_key,reference,saved,revision,created_at,saved_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,1,$7,$7,$7) ON CONFLICT(account_id,reference_key) DO UPDATE SET saved=$6,revision=account_reading_bookmarks_v2.revision+1,saved_at=CASE WHEN $6 THEN $7 ELSE account_reading_bookmarks_v2.saved_at END,updated_at=$7`, id, owner, subject, ref.Key(), string(encode(ref)), cmd.Saved, s.now())
				} else {
					_, e = tx.Exec(ctx, `INSERT INTO reading_bookmarks_v1(id,subject_id,reference_key,reference,saved,revision,created_at,saved_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,1,$6,$6,$6) ON CONFLICT(subject_id,reference_key) DO UPDATE SET saved=$5,revision=reading_bookmarks_v1.revision+1,saved_at=CASE WHEN $5 THEN $6 ELSE reading_bookmarks_v1.saved_at END,updated_at=$6`, id, owner, ref.Key(), string(encode(ref)), cmd.Saved, s.now())
				}
				if e != nil {
					return nil, e
				}
			}
			state, e := bookmarkStatus(ctx, tx, owner, ref, account)
			if e != nil {
				return nil, e
			}
			result := Object{"state": "acknowledged", "operationId": cmd.OperationID, "payloadHash": hash, "bookmark": state}
			if account {
				kind := "identity"
				var subject any = a.Device.SubjectID
				if a.Official {
					kind = "official-account"
					subject = nil
				}
				_, e = tx.Exec(ctx, `INSERT INTO account_reading_bookmark_operations_v2(account_id,operation_id,origin_subject_id,authorization_kind,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, owner, cmd.OperationID, subject, kind, hash, string(encode(result)), s.now())
			} else {
				_, e = tx.Exec(ctx, `INSERT INTO `+operations+`(subject_id,operation_id,request_hash,result,created_at) VALUES($1,$2,$3,$4::jsonb,$5)`, owner, cmd.OperationID, hash, string(encode(result)), s.now())
			}
			return result, e
		}
		return nil, fault.New("not_found", 404)
	})
}

type bookmarkCursor struct {
	AccountID string `json:"accountId"`
	Category  any    `json:"category"`
	Kind      any    `json:"kind"`
	At        string `json:"at"`
	ID        string `json:"id"`
}

func (s *Service) bookmarkQuery(ctx context.Context, tx pgx.Tx, a Actor, account bool, p Object) (Object, error) {
	owner := ownerID(a, account)
	table, _, column, _, _ := tables(account)
	var at, id any
	if after := str(p, "after"); after != "" {
		if !account {
			r, e := row(ctx, tx, `SELECT id,saved_at FROM reading_bookmarks_v1 WHERE subject_id=$1 AND id=$2`, owner, after)
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, fault.New("reading_bookmark_cursor_unavailable", 409)
			}
			at = r["saved_at"]
			id = r["id"]
		} else {
			raw, e := base64.RawURLEncoding.DecodeString(after[4:])
			var c Object
			if e != nil || protocol.Decode(raw, &c) != nil || c["accountId"] != owner || c["category"] != p["category"] || c["kind"] != p["kind"] || !validID(str(c, "id")) {
				return nil, fault.New("reading_bookmark_cursor_unavailable", 409)
			}
			if _, ok := c["category"]; !ok {
				return nil, fault.New("reading_bookmark_cursor_unavailable", 409)
			}
			if _, ok := c["kind"]; !ok {
				return nil, fault.New("reading_bookmark_cursor_unavailable", 409)
			}
			t, e := parseDate(str(c, "at"))
			if e != nil {
				return nil, fault.New("reading_bookmark_cursor_unavailable", 409)
			}
			at = t
			id = c["id"]
		}
	}
	limit := num(p, "limit")
	query := `SELECT * FROM ` + table + ` WHERE ` + column + `=$1 AND saved=true AND ($2::text IS NULL OR reference->>'kind'=$2) `
	args := []any{owner, p["kind"], at, id, limit + 1}
	if account {
		query += `AND ($6::text IS NULL OR CASE WHEN $6='private-chat' THEN reference->>'kind'='chat-message' ELSE reference->>'kind'<>'chat-message' END) `
		args = append(args, p["category"])
	}
	query += `AND ($3::timestamptz IS NULL OR (saved_at,id)<($3::timestamptz,$4::uuid)) ORDER BY saved_at DESC,id DESC LIMIT $5`
	rr, e := rows(ctx, tx, query, args...)
	if e != nil {
		return nil, e
	}
	out := []Object{}
	var next any
	for i, r := range rr {
		if int64(i) == limit {
			last := rr[i-1]
			if account {
				next = "rb2." + base64.RawURLEncoding.EncodeToString(encode(bookmarkCursor{owner, p["category"], p["kind"], date(last["saved_at"]).(string), str(last, "id")}))
			} else {
				next = last["id"]
			}
			break
		}
		ref, ok := reference(r["reference"])
		if !ok {
			return nil, fault.New("invalid_reading_bookmark_request", 400)
		}
		item := bookmarkState(ref, r)
		item["source"] = s.source(ctx, tx, a, ref)
		out = append(out, item)
	}
	result := Object{"items": out, "nextAfter": next, "checkedAt": s.now().Unix(), "visibility": "Private"}
	if account {
		result["accountId"] = owner
	}
	return result, nil
}
