package operationsaccounts

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
	"slices"
	"strconv"
	"unicode/utf8"
)

var guid = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var revisionCursor = regexp.MustCompile(`^[1-9][0-9]{0,9}$`)

func parsePage(input Object, history bool) (Object, error) {
	if input == nil {
		input = Object{}
	}
	if !strict(input, nil, []string{"after", "limit"}) {
		return nil, invalid()
	}
	limit := int64(20)
	if history {
		limit = 100
	}
	if v, ok := input["limit"]; ok {
		n, valid := number(v)
		if !valid || n < 1 || n > 100 {
			return nil, invalid()
		}
		limit = n
	}
	out := Object{"limit": limit}
	if v, ok := input["after"]; ok {
		cursor, is := v.(string)
		if !is {
			return nil, invalid()
		}
		if history {
			n, e := strconv.ParseInt(cursor, 10, 32)
			if e != nil || n < 1 || !revisionCursor.MatchString(cursor) {
				return nil, invalid()
			}
		} else if !guid.MatchString(cursor) {
			return nil, invalid()
		}
		out["after"] = cursor
	}
	return out, nil
}
func (s *Service) linksWithin(ctx context.Context, tx pgx.Tx, id string, input Object) (Object, error) {
	p, e := parsePage(input, false)
	if e != nil {
		return nil, e
	}
	limit := num(p["limit"])
	rr, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT g.subject_id,min(g.created_at) AS linked_at,CASE WHEN bool_or(l.revoked_at IS NULL) THEN NULL ELSE max(l.revoked_at) END AS revoked_at,bool_or(l.revoked_at IS NULL) AS active FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id WHERE g.account_id=$1 AND l.endpoint=$2 AND ($3::text IS NULL OR g.subject_id>$3) GROUP BY g.subject_id ORDER BY g.subject_id LIMIT $4)r`, id, s.Domain.Endpoint, p["after"], limit+1)
	if e != nil {
		return nil, e
	}
	out := []any{}
	var next any
	for i, r := range rr {
		if int64(i) >= limit {
			next = rr[i-1]["subject_id"]
			break
		}
		state := "revoked"
		if r["active"] == true {
			state = "active"
		}
		out = append(out, Object{"subjectId": r["subject_id"], "linkedAt": stamp(r["linked_at"]), "revokedAt": stamp(r["revoked_at"]), "state": state})
	}
	return Object{"items": out, "nextAfter": next}, nil
}
func (s *Service) historyWithin(ctx context.Context, tx pgx.Tx, id string, input Object) (Object, error) {
	p, e := parsePage(input, true)
	if e != nil {
		return nil, e
	}
	limit := num(p["limit"])
	rr, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT revision,previous_type,next_type,reason,basis,created_at,actor_kind,operator_id FROM official_account_type_history_v1 WHERE account_id=$1 AND ($2::integer IS NULL OR revision<$2) ORDER BY revision DESC LIMIT $3)r`, id, p["after"], limit+1)
	if e != nil {
		return nil, e
	}
	out := []any{}
	var next any
	for i, r := range rr {
		if int64(i) >= limit {
			next = strconv.FormatInt(num(rr[i-1]["revision"]), 10)
			break
		}
		out = append(out, Object{"previousType": r["previous_type"], "nextType": r["next_type"], "revision": r["revision"], "reason": r["reason"], "basis": r["basis"], "createdAt": stamp(r["created_at"]), "actorKind": r["actor_kind"], "operatorId": r["operator_id"]})
	}
	return Object{"items": out, "nextAfter": next}, nil
}
func (s *Service) identityFor(ctx context.Context, r Object, a Actor) Object {
	out := Object{"issuer": r["issuer"], "externalSubject": r["external_subject"], "email": nil, "emailVerified": nil, "enabled": nil, "state": "not-authorized"}
	if !slices.Contains(a.Permissions, "accounts.identity.read") {
		return out
	}
	out["state"] = "not-configured"
	if s.LookupIdentity == nil {
		return out
	}
	got, e := s.LookupIdentity(ctx, str(r["issuer"]), str(r["external_subject"]))
	if e != nil || got != nil && (got["issuer"] != r["issuer"] || got["externalSubject"] != r["external_subject"]) {
		out["state"] = "temporarily-unavailable"
		return out
	}
	if got == nil || got["state"] == "not-found" {
		out["state"] = "not-found"
		return out
	}
	out["state"] = "available"
	if v, ok := got["email"].(string); ok && utf8.RuneCountInString(v) <= 320 {
		out["email"] = v
	}
	for _, k := range []string{"emailVerified", "enabled"} {
		if v, ok := got[k].(bool); ok {
			out[k] = v
		}
	}
	return out
}
func (s *Service) Get(ctx context.Context, a Actor, id string) (Object, error) {
	actor, e := s.fresh(ctx, a, "accounts.read")
	if e != nil {
		return nil, e
	}
	d := s.domain()
	type loaded struct{ row, history, links, summary Object }
	data, e := postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (loaded, error) {
		r, e := s.AccountWithin(ctx, tx, id, false)
		if e != nil {
			return loaded{}, e
		}
		history, e := s.historyWithin(ctx, tx, id, nil)
		if e != nil {
			return loaded{}, e
		}
		links, e := s.linksWithin(ctx, tx, id, nil)
		if e != nil {
			return loaded{}, e
		}
		summary, e := one(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT count(*) FILTER(WHERE active)::integer AS active,count(*) FILTER(WHERE NOT active)::integer AS revoked FROM (SELECT g.subject_id,bool_or(l.revoked_at IS NULL) AS active FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id WHERE g.account_id=$1 AND l.endpoint=$2 GROUP BY g.subject_id)links)r`, id, d.Endpoint)
		return loaded{r, history, links, summary}, e
	})
	if e != nil {
		return nil, e
	}
	r := data.row
	account := Object{"accountId": r["id"], "uid": r["uid"], "displayName": r["display_name"], "avatarKey": r["avatar_key"], "subjectType": r["subject_type"], "profileRevision": coalesce(r["revision"], 0), "createdAt": stamp(r["created_at"]), "verifiedAt": stamp(r["verified_at"]), "identity": s.identityFor(ctx, r, actor), "restriction": s.restriction(r), "links": Object{"activeCount": data.summary["active"], "revokedCount": data.summary["revoked"]}}
	_, e = postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (bool, error) {
		current, e := d.Fresh(ctx, tx, actor, "accounts.read")
		if e != nil {
			return false, e
		}
		if slices.Contains(actor.Permissions, "accounts.identity.read") {
			if _, e = d.Fresh(ctx, tx, current, "accounts.identity.read"); e != nil {
				return false, e
			}
		}
		e = d.RecordAccountRead(ctx, tx, current, "user-read", Object{}, Object{"view": "business-account-metadata"}, id)
		return e == nil, e
	})
	if e != nil {
		return nil, e
	}
	return Object{"account": account, "profile": Object{"revision": coalesce(r["revision"], 0), "avatarKey": r["avatar_key"], "bio": coalesce(r["bio"], ""), "publicQuery": Object{"enabled": r["query_enabled"] == true, "scope": coalesce(r["query_scope"], "profile"), "showLinkedIds": r["query_linked_ids"] == true, "showExternalCredentials": r["query_external_credentials"] == true}}, "typeHistory": data.history["items"], "typeHistoryNextAfter": data.history["nextAfter"], "linkedIds": data.links, "checkedAt": s.now().Unix(), "permissions": capabilities(actor)}, nil
}
func (s *Service) paged(ctx context.Context, a Actor, id string, input Object, history bool) (Object, error) {
	actor, e := s.fresh(ctx, a, "accounts.read")
	if e != nil {
		return nil, e
	}
	d := s.domain()
	return postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e = s.AccountWithin(ctx, tx, id, false); e != nil {
			return nil, e
		}
		var result Object
		view := "association-metadata"
		metadata := Object{}
		if history {
			result, e = s.historyWithin(ctx, tx, id, input)
			view = "type-history"
			if e == nil {
				metadata["count"] = len(result["items"].([]any))
			}
		} else {
			result, e = s.linksWithin(ctx, tx, id, input)
			ids := []any{}
			if e == nil {
				for _, v := range result["items"].([]any) {
					ids = append(ids, obj(v)["subjectId"])
				}
				metadata["subjectIds"] = ids
			}
		}
		if e != nil {
			return nil, e
		}
		if e = d.RecordAccountRead(ctx, tx, actor, "user-read", Object{"view": view, "after": input["after"]}, metadata, id); e != nil {
			return nil, e
		}
		result["checkedAt"] = s.now().Unix()
		return result, nil
	})
}
func (s *Service) Links(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.paged(ctx, a, id, input, false)
}
func (s *Service) TypeHistory(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.paged(ctx, a, id, input, true)
}
