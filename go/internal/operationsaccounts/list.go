package operationsaccounts

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var uidCursor = regexp.MustCompile(`^G[A-Z0-9]{10}[0-9]$`)
var emailBody = regexp.MustCompile(`^[A-Za-z0-9_'+.\-]*[A-Za-z0-9_+\-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)

func ParseList(input Object) (Object, error) {
	if input == nil {
		input = Object{}
	}
	if !strict(input, nil, []string{"query", "after", "limit", "subjectType", "restriction"}) {
		return nil, invalid()
	}
	out := Object{"query": "", "limit": int64(20)}
	for k, v := range input {
		out[k] = v
	}
	query, ok := out["query"].(string)
	query = trim(query)
	if !ok || utf8.RuneCountInString(query) > 320 {
		return nil, invalid()
	}
	out["query"] = query
	n, ok := number(out["limit"])
	if !ok || n < 1 || n > 100 {
		return nil, invalid()
	}
	out["limit"] = n
	if v, has := out["after"]; has && !uidCursor.MatchString(str(v)) {
		return nil, invalid()
	}
	if v, has := out["subjectType"]; has && !slices.Contains([]string{"person", "organization", "agent", "unknown"}, str(v)) {
		return nil, invalid()
	}
	if v, has := out["restriction"]; has && !slices.Contains([]string{"normal", "restricted"}, str(v)) {
		return nil, invalid()
	}
	return out, nil
}
func (s *Service) List(ctx context.Context, a Actor, input Object) (Object, error) {
	actor, e := s.fresh(ctx, a, "accounts.read")
	if e != nil {
		return nil, e
	}
	q, e := ParseList(input)
	if e != nil {
		return nil, e
	}
	text := str(q["query"])
	email := emailBody.MatchString(text) && !strings.HasPrefix(text, ".") && !strings.Contains(text, "..")
	known := map[string]Object{}
	matches := []Object{}
	if email {
		if _, e = s.fresh(ctx, actor, "accounts.identity.read"); e != nil {
			return nil, e
		}
		if s.FindByEmail == nil {
			return nil, fail("identity_directory_unavailable", 503)
		}
		found, err := s.FindByEmail(ctx, text)
		if err != nil || found == nil || len(found) > 1000 {
			return nil, fail("identity_directory_unavailable", 503)
		}
		for _, r := range found {
			issuer, is := r["issuer"].(string)
			sub, valid := r["externalSubject"].(string)
			if is && valid && utf8.RuneCountInString(sub) > 0 && utf8.RuneCountInString(sub) <= 255 {
				known[issuer+"\x00"+sub] = r
				matches = append(matches, Object{"issuer": issuer, "externalSubject": sub})
			}
		}
	}
	d := s.domain()
	loaded, e := postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) ([]Object, error) {
		return rows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT `+accountColumns+` FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.endpoint=$1 AND ($2::text IS NULL OR a.uid>$2) AND CASE WHEN $3::boolean THEN EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) candidate WHERE candidate->>'issuer'=a.issuer AND candidate->>'externalSubject'=a.external_subject) ELSE $5::text='' OR position(lower($5::text) in lower(coalesce(p.display_name,'')))>0 OR position(upper($5::text) in a.uid)>0 OR a.id::text=$5::text END AND ($7::text IS NULL OR CASE WHEN $7='unknown' THEN p.subject_type IS NULL ELSE p.subject_type=$7 END) AND ($8::text IS NULL OR CASE WHEN $8='restricted' THEN a.restricted_until>$9::timestamptz ELSE a.restricted_until IS NULL OR a.restricted_until<=$9::timestamptz END) ORDER BY a.uid LIMIT $6)r`, d.Endpoint, q["after"], email, matches, text, num(q["limit"])+1, q["subjectType"], q["restriction"], s.now())
	})
	if e != nil {
		return nil, e
	}
	out := []any{}
	ids := []any{}
	var next any
	for i, r := range loaded {
		if int64(i) >= num(q["limit"]) {
			next = loaded[i-1]["uid"]
			break
		}
		identity := Object(nil)
		if found := known[str(r["issuer"])+"\x00"+str(r["external_subject"])]; found != nil {
			facade := *s
			facade.LookupIdentity = func(context.Context, string, string) (Object, error) { return found, nil }
			identity = facade.identityFor(ctx, r, actor)
		} else {
			identity = s.identityFor(ctx, r, actor)
		}
		counts, e := postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Object, error) {
			return one(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT count(*) FILTER(WHERE active)::integer AS active,count(*) FILTER(WHERE NOT active)::integer AS revoked FROM (SELECT g.subject_id,bool_or(l.revoked_at IS NULL) AS active FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id WHERE g.account_id=$1 AND l.endpoint=$2 GROUP BY g.subject_id)links)r`, r["id"], d.Endpoint)
		})
		if e != nil {
			return nil, e
		}
		out = append(out, Object{"accountId": r["id"], "uid": r["uid"], "displayName": r["display_name"], "avatarKey": r["avatar_key"], "subjectType": r["subject_type"], "profileRevision": coalesce(r["revision"], 0), "createdAt": stamp(r["created_at"]), "verifiedAt": stamp(r["verified_at"]), "identity": identity, "restriction": s.restriction(r), "links": Object{"activeCount": counts["active"], "revokedCount": counts["revoked"]}})
		ids = append(ids, r["id"])
	}
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
		kind := "all"
		if email {
			kind = "email"
		} else if text != "" {
			kind = "uid-or-username"
		}
		e = d.RecordAccountRead(ctx, tx, current, "users-query", Object{"queryKind": kind, "after": q["after"], "limit": q["limit"], "subjectType": q["subjectType"], "restriction": q["restriction"]}, Object{"accountIds": ids, "count": len(out)}, nil)
		return e == nil, e
	})
	if e != nil {
		return nil, e
	}
	return Object{"items": out, "nextAfter": next, "checkedAt": s.now().Unix(), "permissions": capabilities(actor)}, nil
}
