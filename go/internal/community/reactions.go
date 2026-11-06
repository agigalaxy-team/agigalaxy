package community

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"strings"
)

type reactionObject struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type reactionCommand struct {
	OperationID      string `json:"operationId"`
	Kind             string `json:"kind"`
	ID               string `json:"id"`
	Liked            bool   `json:"liked"`
	ExpectedRevision int64  `json:"expectedRevision"`
}

func (s *Service) reactionView(ctx context.Context, tx pgx.Tx, account string, o reactionObject) (Object, error) {
	var view Object
	var e error
	if o.Kind == "post" {
		view, e = s.readPost(ctx, tx, o.ID, account)
	} else {
		view, e = s.readReply(ctx, tx, o.ID, account)
	}
	if e != nil {
		return nil, e
	}
	if str(view, "availability") != "available" {
		return nil, fail("not_found", 404)
	}
	var count, revision int64
	var liked bool
	e = tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE liked),coalesce(bool_or(liked) FILTER (WHERE account_id=$3),false),coalesce(max(revision) FILTER (WHERE account_id=$3),0) FROM forum_reactions_v1 WHERE kind=$1 AND object_id=$2`, o.Kind, o.ID, null(account)).Scan(&count, &liked, &revision)
	return Object{"kind": o.Kind, "id": o.ID, "count": count, "liked": liked, "revision": revision}, e
}
func (s *Service) Reactions(ctx context.Context, account, method string, raw []byte) (Object, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, invalid()
	}
	validObject := func(o reactionObject) bool { return (o.Kind == "post" || o.Kind == "reply") && validID(o.ID) }
	switch method {
	case "status":
		var p struct {
			Objects []reactionObject `json:"objects"`
		}
		if len(fields) != 1 || protocol.Decode(raw, &p) != nil || len(p.Objects) < 1 || len(p.Objects) > 100 {
			return nil, invalid()
		}
		for _, o := range p.Objects {
			if !validObject(o) {
				return nil, invalid()
			}
		}
		return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
			items := []Object{}
			for _, o := range p.Objects {
				v, e := s.reactionView(ctx, tx, account, o)
				if e != nil {
					return nil, e
				}
				items = append(items, v)
			}
			return Object{"items": items}, nil
		})
	case "receipt":
		var p struct {
			OperationID string `json:"operationId"`
			PayloadHash string `json:"payloadHash"`
		}
		if len(fields) != 2 || protocol.Decode(raw, &p) != nil || !validID(p.OperationID) || len(p.PayloadHash) != 64 || !validID(account) {
			return nil, invalid()
		}
		if _, e := hex.DecodeString(p.PayloadHash); e != nil || p.PayloadHash != strings.ToLower(p.PayloadHash) {
			return nil, invalid()
		}
		return s.run(ctx, account, func(tx pgx.Tx) (Object, error) {
			return reactionReceipt(ctx, tx, account, p.OperationID, p.PayloadHash)
		})
	case "command":
		var p reactionCommand
		if len(fields) != 5 || protocol.Decode(raw, &p) != nil || !validID(p.OperationID) || !validObject(reactionObject{p.Kind, p.ID}) || p.ExpectedRevision < 0 || p.ExpectedRevision > 9007199254740991 || string(fields["liked"]) == "null" || string(fields["expectedRevision"]) == "null" || !validID(account) {
			return nil, invalid()
		}
		var liked bool
		if json.Unmarshal(fields["liked"], &liked) != nil {
			return nil, invalid()
		}
		hash := identity.Digest(encode(p))
		return s.runWrite(ctx, account, false, func(tx pgx.Tx) (Object, error) {
			if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,839193))`, account+":"+p.OperationID); e != nil {
				return nil, e
			}
			prior, e := reactionReceipt(ctx, tx, account, p.OperationID, hash)
			if e != nil {
				return nil, e
			}
			if prior["state"] == "acknowledged" {
				return prior, nil
			}
			if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,839194))`, account+":"+p.Kind+":"+p.ID); e != nil {
				return nil, e
			}
			if _, e = s.writeAccount(ctx, tx, account, false); e != nil {
				return nil, e
			}
			postID := p.ID
			if p.Kind == "reply" {
				reply, e := s.reply(ctx, tx, p.ID)
				if e != nil {
					return nil, e
				}
				if reply == nil {
					return nil, fail("not_found", 404)
				}
				postID = str(reply, "post_id")
			}
			parent, e := s.readPost(ctx, tx, postID, account)
			if e != nil {
				return nil, e
			}
			if str(parent, "availability") != "available" || !truth(parent, "canParticipate") {
				return nil, fail("forum_participation_denied", 403)
			}
			view, e := s.reactionView(ctx, tx, account, reactionObject{p.Kind, p.ID})
			if e != nil {
				return nil, e
			}
			if num(view, "revision") != p.ExpectedRevision {
				return nil, fail("forum_reaction_changed", 409)
			}
			if truth(view, "liked") != p.Liked {
				revision := p.ExpectedRevision + 1
				_, e = tx.Exec(ctx, `INSERT INTO forum_reactions_v1(account_id,kind,object_id,liked,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,kind,object_id) DO UPDATE SET liked=excluded.liked,revision=excluded.revision,updated_at=excluded.updated_at`, account, p.Kind, p.ID, p.Liked, revision, s.now())
				if e != nil {
					return nil, e
				}
				var source Object
				if p.Kind == "post" {
					source, e = s.head(ctx, tx, p.ID, false)
				} else {
					source, e = s.reply(ctx, tx, p.ID)
				}
				if e != nil {
					return nil, e
				}
				post := p.ID
				if p.Kind == "reply" {
					post = str(source, "post_id")
				}
				if s.OnReactionWithin != nil {
					if e = s.OnReactionWithin(ctx, tx, ReactionChange{AccountID: account, Kind: p.Kind, ID: p.ID, AuthorAccountID: str(source, "account_id"), PostID: post, Liked: p.Liked, Revision: revision}); e != nil {
						return nil, e
					}
				}
			}
			view, e = s.reactionView(ctx, tx, account, reactionObject{p.Kind, p.ID})
			if e != nil {
				return nil, e
			}
			result := Object{"state": "acknowledged", "accountId": account, "operationId": p.OperationID, "payloadHash": hash, "reaction": view}
			_, e = tx.Exec(ctx, `INSERT INTO forum_reaction_operations_v1(account_id,operation_id,request_hash,result,created_at) VALUES($1,$2,$3,$4::jsonb,$5)`, account, p.OperationID, hash, string(encode(result)), s.now())
			return result, e
		})
	}
	return nil, fail("not_found", 404)
}
func reactionReceipt(ctx context.Context, tx pgx.Tx, account, id, hash string) (Object, error) {
	r, e := row(ctx, tx, `SELECT to_jsonb(r) FROM forum_reaction_operations_v1 r WHERE account_id=$1 AND operation_id=$2`, account, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return Object{"state": "absent", "accountId": account, "operationId": id, "payloadHash": hash}, nil
	}
	if str(r, "request_hash") != hash {
		return nil, fail("forum_reaction_operation_conflict", 409)
	}
	return obj(r, "result"), nil
}
