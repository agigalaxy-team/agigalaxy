package accountsocial

import (
	"context"
	"encoding/base64"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func relationship(target string, r Object) Object {
	if r == nil {
		return Object{"id": nil, "targetAccountId": target, "following": false, "revision": 0, "followedAt": nil, "updatedAt": nil}
	}
	return Object{"id": r["id"], "targetAccountId": target, "following": r["following"], "revision": r["revision"], "followedAt": date(r["followed_at"]), "updatedAt": date(r["updated_at"])}
}
func followStatus(ctx context.Context, tx pgx.Tx, owner, target string) (Object, error) {
	r, e := row(ctx, tx, `SELECT id,following,revision,followed_at,updated_at FROM account_follows_v1 WHERE account_id=$1 AND target_account_id=$2`, owner, target)
	if e != nil {
		return nil, e
	}
	return relationship(target, r), nil
}
func (s *Service) target(ctx context.Context, tx pgx.Tx, id string, lock bool) (Object, error) {
	if s.Accounts == nil {
		return nil, fault.New("account_follow_unavailable", 503)
	}
	if lock {
		if _, e := tx.Exec(ctx, `SELECT account_id FROM official_account_profiles_v1 WHERE account_id=$1 FOR SHARE`, id); e != nil {
			return nil, e
		}
	}
	profile, e := s.Accounts.PublicProfileWithin(ctx, tx, id, nil)
	if fault.Code(e) == "not_found" {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	return Object{"accountId": id, "uid": profile["uid"], "displayName": profile["displayName"], "subjectType": profile["subjectType"]}, nil
}
func followReceipt(ctx context.Context, tx pgx.Tx, owner, id, hash string) (Object, error) {
	r, e := row(ctx, tx, `SELECT request_hash,result FROM account_follow_operations_v1 WHERE account_id=$1 AND operation_id=$2`, owner, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return Object{"state": "absent", "accountId": owner, "operationId": id, "payloadHash": hash}, nil
	}
	if r["request_hash"] != hash {
		return nil, fault.New("account_follow_operation_conflict", 409)
	}
	return object(r, "result"), nil
}
func (s *Service) Follow(ctx context.Context, a Actor, method string, raw []byte) (Object, error) {
	p, e := parse(raw, method, true, true)
	if e != nil {
		return nil, e
	}
	if !a.Official || a.Endpoint != s.Endpoint || !validID(a.AccountID) {
		return nil, fault.New("official_account_login_required", 401)
	}
	return s.run(ctx, a, true, method == "command", func(tx pgx.Tx, a Actor) (Object, error) {
		owner := a.AccountID
		target := str(p, "targetAccountId")
		switch method {
		case "status":
			state, e := followStatus(ctx, tx, owner, target)
			if e != nil {
				return nil, e
			}
			profile, e := s.target(ctx, tx, target, false)
			if e != nil {
				return nil, e
			}
			return Object{"accountId": owner, "relationship": state, "canFollow": owner != target && profile != nil, "checkedAt": s.now().Unix()}, nil
		case "receipt":
			return followReceipt(ctx, tx, owner, str(p, "operationId"), str(p, "payloadHash"))
		case "query":
			return s.followQuery(ctx, tx, owner, p)
		case "command":
			cmd := followCommand{str(p, "operationId"), target, p["following"].(bool), num(p, "expectedRevision")}
			hash := identity.Digest(encode(cmd))
			if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,839191))`, owner+":"+cmd.OperationID); e != nil {
				return nil, e
			}
			prior, e := followReceipt(ctx, tx, owner, cmd.OperationID, hash)
			if e != nil {
				return nil, e
			}
			if prior["state"] == "acknowledged" {
				return prior, nil
			}
			if owner == target {
				return nil, fault.New("account_follow_self", 409)
			}
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,839192))`, owner+":"+target); e != nil {
				return nil, e
			}
			r, e := row(ctx, tx, `SELECT id,following,revision,followed_at,updated_at FROM account_follows_v1 WHERE account_id=$1 AND target_account_id=$2 FOR UPDATE`, owner, target)
			if e != nil {
				return nil, e
			}
			if num(r, "revision") != cmd.ExpectedRevision {
				return nil, fault.New("account_follow_changed", 409)
			}
			if cmd.Following {
				profile, e := s.target(ctx, tx, target, true)
				if e != nil {
					return nil, e
				}
				if profile == nil {
					return nil, fault.New("account_follow_target_unavailable", 404)
				}
			}
			old := false
			if r != nil {
				old = r["following"] == true
			}
			if old != cmd.Following {
				id := uuid.NewString()
				if r != nil {
					id = str(r, "id")
				}
				_, e = tx.Exec(ctx, `INSERT INTO account_follows_v1(id,account_id,target_account_id,following,revision,created_at,followed_at,updated_at) VALUES($1,$2,$3,$4,1,$5,$5,$5) ON CONFLICT(account_id,target_account_id) DO UPDATE SET following=$4,revision=account_follows_v1.revision+1,followed_at=CASE WHEN $4 THEN $5 ELSE account_follows_v1.followed_at END,updated_at=$5`, id, owner, target, cmd.Following, s.now())
				if e != nil {
					return nil, e
				}
			}
			state, e := followStatus(ctx, tx, owner, target)
			if e != nil {
				return nil, e
			}
			result := Object{"state": "acknowledged", "accountId": owner, "operationId": cmd.OperationID, "payloadHash": hash, "relationship": state}
			_, e = tx.Exec(ctx, `INSERT INTO account_follow_operations_v1(account_id,operation_id,request_hash,result,created_at) VALUES($1,$2,$3,$4::jsonb,$5)`, owner, cmd.OperationID, hash, string(encode(result)), s.now())
			return result, e
		}
		return nil, fault.New("not_found", 404)
	})
}

type followCursor struct {
	AccountID string `json:"accountId"`
	At        string `json:"at"`
	ID        string `json:"id"`
}

func (s *Service) followQuery(ctx context.Context, tx pgx.Tx, owner string, p Object) (Object, error) {
	var at, id any
	if after := str(p, "after"); after != "" {
		var c followCursor
		raw, e := base64.RawURLEncoding.DecodeString(after[4:])
		fields, e2 := shape(raw, []string{"accountId", "at", "id"}, nil, "account_follow_cursor_unavailable")
		_ = fields
		if e != nil || e2 != nil || protocol.Decode(raw, &c) != nil || c.AccountID != owner || !validID(c.ID) {
			return nil, fault.New("account_follow_cursor_unavailable", 409)
		}
		t, e := parseDate(c.At)
		if e != nil {
			return nil, fault.New("account_follow_cursor_unavailable", 409)
		}
		at = t
		id = c.ID
	}
	limit := num(p, "limit")
	rr, e := rows(ctx, tx, `SELECT id,target_account_id,following,revision,followed_at,updated_at FROM account_follows_v1 WHERE account_id=$1 AND following=true AND ($2::timestamptz IS NULL OR (followed_at,id)<($2::timestamptz,$3::uuid)) ORDER BY followed_at DESC,id DESC LIMIT $4`, owner, at, id, limit+1)
	if e != nil {
		return nil, e
	}
	out := []Object{}
	var next any
	for i, r := range rr {
		if int64(i) == limit {
			last := rr[i-1]
			next = "af1." + base64.RawURLEncoding.EncodeToString(encode(followCursor{owner, date(last["followed_at"]).(string), str(last, "id")}))
			break
		}
		profile, e := s.target(ctx, tx, str(r, "target_account_id"), false)
		if e != nil {
			return nil, e
		}
		source := Object{"state": "unavailable", "profile": nil}
		if profile != nil {
			source = Object{"state": "available", "profile": profile}
		}
		out = append(out, Object{"relationship": relationship(str(r, "target_account_id"), r), "source": source})
	}
	atNow := s.now().Unix()
	return Object{"accountId": owner, "items": out, "nextAfter": next, "checkedAt": atNow, "readExpiresAt": atNow + 30, "visibility": "Private"}, nil
}
func parseDate(value string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02", "2006-01", "2006", "Mon, 02 Jan 2006 15:04:05 MST"} {
		if t, e := time.Parse(layout, value); e == nil {
			return t, nil
		}
	}
	return time.Time{}, fault.New("invalid_cursor", 400)
}
