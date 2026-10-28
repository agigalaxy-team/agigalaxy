package registeredusers

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"math"
	"strings"
	"time"
)

const columns = `s.id AS registration_id,s.issuer,s.external_subject,e.present,e.email,e.email_verified,e.enabled,e.registered_at,e.identity_display_name,e.observed_at,
 a.id AS account_id,a.uid,a.created_at AS business_created_at,a.verified_at,a.restricted_until,a.restriction_reason,a.restriction_revision,
 p.account_id AS profile_account_id,p.display_name,p.avatar_key,p.bio,p.subject_type,p.revision AS profile_revision,
 r.account_id AS reserved_account_id,r.uid AS reserved_uid,r.display_name AS preset_name,r.avatar_key AS preset_avatar_key,r.bio AS preset_bio,
 r.preset_revision,r.updated_at AS preset_updated_at,r.adopted_at AS preset_adopted_at`
const registrationJoin = `FROM operations_registered_subjects_v1 s JOIN operations_registered_entries_v1 e ON e.registration_id=s.id AND e.generation_id=$2
 LEFT JOIN community_accounts a ON a.endpoint=s.endpoint AND a.issuer=s.issuer AND a.external_subject=s.external_subject
 LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id
 LEFT JOIN official_account_registrations_v1 r ON r.endpoint=s.endpoint AND r.issuer=s.issuer AND r.external_subject=s.external_subject WHERE s.endpoint=$1`

func (s *Service) actor(ctx context.Context, tx pgx.Tx, a Actor, action string) (Actor, error) {
	queryAllowed := false
	if q, ok := s.Authority.(interface{ AcceptsQuery(Actor) bool }); ok {
		queryAllowed = q.AcceptsQuery(a)
	}
	if s.Authority == nil || a.AIProof != nil && !queryAllowed {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if action == "" {
		action = "accounts.registered.read"
	}
	return s.Authority.RequireWithin(ctx, tx, a, action)
}
func (s *Service) current(ctx context.Context, a Actor, action string) (Actor, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return Actor{}, e
	}
	defer tx.Rollback(ctx)
	fresh, e := s.actor(ctx, tx, a, action)
	if e != nil {
		return Actor{}, e
	}
	return fresh, tx.Commit(ctx)
}
func (s *Service) read(ctx context.Context, a Actor, f func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	actor, e := s.actor(ctx, tx, a, "")
	if e != nil {
		return nil, e
	}
	o, e := f(tx, actor)
	if e != nil {
		return nil, e
	}
	if _, e = s.actor(ctx, tx, actor, ""); e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return s.stamp(o), nil
}
func many(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		var o Object
		if e = json.Unmarshal(raw, &o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func permissionView(a Actor) Object {
	return Object{"canReadIdentity": has(a.Permissions, "accounts.identity.read"), "canReadProfile": has(a.Permissions, "accounts.read")}
}
func valueDefault(v, def any) any {
	if v == nil {
		return def
	}
	return v
}
func (s *Service) item(row Object, u *User, readIdentity bool, stage Object) Object {
	native := Object{"email": row["email"], "emailVerified": row["email_verified"], "enabled": row["enabled"], "registeredAt": nullableStamp(row["registered_at"]), "displayName": row["identity_display_name"]}
	if u != nil {
		native = Object{"email": u.Email, "emailVerified": u.EmailVerified, "enabled": u.Enabled, "registeredAt": u.RegisteredAt, "displayName": u.DisplayName}
	}
	presence := "not-found"
	if s.Directory == nil || row["issuer"] != s.Directory.Issuer() {
		presence = "outside-configured-issuer"
	} else if u != nil || row["present"] == true {
		presence = "present"
	}
	identity := Object{"source": "keycloak-website", "issuer": nil, "subject": nil, "email": nil, "emailVerified": native["emailVerified"], "enabled": native["enabled"], "registeredAt": native["registeredAt"], "displayName": native["displayName"], "presence": presence, "readState": "not-authorized"}
	if readIdentity {
		identity["issuer"], identity["subject"], identity["email"], identity["readState"] = row["issuer"], row["external_subject"], native["email"], "available"
	}
	var business, profile any
	if row["account_id"] != nil {
		until, _ := time.Parse(time.RFC3339Nano, str(row["restricted_until"]))
		restriction := Object{"scope": "community-participation", "active": !until.IsZero() && until.After(s.now()), "until": nullableStamp(row["restricted_until"]), "reason": row["restriction_reason"], "revision": valueDefault(row["restriction_revision"], 0)}
		business = Object{"accountId": row["account_id"], "uid": row["uid"], "displayName": row["display_name"], "avatarKey": row["avatar_key"], "subjectType": row["subject_type"], "profileRevision": valueDefault(row["profile_revision"], 0), "businessCreatedAt": nullableStamp(row["business_created_at"]), "verifiedAt": nullableStamp(row["verified_at"]), "restriction": restriction}
	} else if row["reserved_account_id"] != nil {
		state, name := "reserved", any("")
		if integer(row["preset_revision"]) > 0 {
			state = "preset"
			name = valueDefault(row["preset_name"], "")
		}
		profile = Object{"state": state, "reservedAccountId": row["reserved_account_id"], "uid": row["reserved_uid"], "displayName": name, "avatarKey": row["preset_avatar_key"], "revision": row["preset_revision"], "updatedAt": nullableStamp(row["preset_updated_at"])}
	}
	if stage == nil {
		stage = Object{"state": "unknown", "basis": "not-read"}
	}
	return Object{"registrationId": row["registration_id"], "identity": identity, "business": business, "registrationProfile": profile, "stage": stage, "observedAt": nullableStamp(row["observed_at"])}
}
func (s *Service) List(ctx context.Context, a Actor, input Object) (Object, error) {
	x, e := ParseList(input)
	if e != nil {
		return nil, e
	}
	return s.read(ctx, a, func(tx pgx.Tx, actor Actor) (Object, error) {
		permissions := permissionView(actor)
		readIdentity := permissions["canReadIdentity"] == true
		query := str(x["query"])
		if strings.Contains(query, "@") && !readIdentity {
			return nil, fail("operations_permission_denied", 403)
		}
		source, e := s.index().Source(ctx, tx)
		if e != nil {
			return nil, e
		}
		pagination := Object{"page": x["page"], "pageSize": x["pageSize"], "total": nil, "matchingTotal": nil, "totalPages": nil}
		if source["generationId"] == nil {
			return Object{"items": []Object{}, "pagination": pagination, "source": source, "permissions": permissions}, nil
		}
		values := []any{s.Endpoint, source["generationId"]}
		where := []string{}
		arg := func(v any) string { values = append(values, v); return fmt.Sprint("$", len(values)) }
		population := " AND (e.present OR a.id IS NOT NULL)"
		if x["source"] == "registered" {
			population = " AND e.present"
		} else if x["source"] == "business-only" {
			population = " AND NOT e.present AND a.id IS NOT NULL"
		}
		if query != "" {
			v := arg(query)
			if readIdentity && strings.Contains(query, "@") {
				where = append(where, "lower(e.email)=lower("+v+")")
			} else {
				email := ""
				if readIdentity {
					email = " OR e.email ILIKE '%'||" + v + "||'%'"
				}
				where = append(where, "(coalesce(a.uid,r.uid) ILIKE '%'||"+v+"||'%' OR coalesce(p.display_name,r.display_name) ILIKE '%'||"+v+"||'%' OR e.identity_display_name ILIKE '%'||"+v+"||'%'"+email+" OR EXISTS(SELECT 1 FROM community_account_links cl WHERE cl.account_id=a.id AND cl.subject_id="+v+"))")
			}
		}
		if v := str(x["subjectType"]); v != "" {
			if v == "unknown" {
				where = append(where, "p.subject_type IS NULL")
			} else {
				where = append(where, "p.subject_type="+arg(v))
			}
		}
		if v := str(x["business"]); v != "" {
			suffix := " IS NULL"
			if v == "formed" {
				suffix = " IS NOT NULL"
			}
			where = append(where, "a.id"+suffix)
		}
		for _, spec := range []struct{ key, col, yes string }{{"login", "e.enabled", "enabled"}, {"emailVerified", "e.email_verified", "yes"}} {
			if v := str(x[spec.key]); v != "" {
				where = append(where, spec.col+"="+arg(v == spec.yes))
			}
		}
		for _, spec := range []struct{ key, op string }{{"registeredFrom", ">="}, {"registeredTo", "<="}} {
			if v := str(x[spec.key]); v != "" {
				where = append(where, "e.registered_at"+spec.op+arg(v)+"::timestamptz")
			}
		}
		if v := str(x["participation"]); v != "" {
			active := "(a.restricted_until IS NOT NULL AND a.restricted_until>" + arg(stamp(s.now())) + "::timestamptz)"
			if v != "restricted" {
				active = "NOT " + active
			}
			where = append(where, "a.id IS NOT NULL AND "+active)
		}
		filtered := ""
		if len(where) > 0 {
			filtered = " AND " + strings.Join(where, " AND ")
		}
		var total, matching int64
		if e = tx.QueryRow(ctx, "SELECT count(*) "+registrationJoin+population, s.Endpoint, source["generationId"]).Scan(&total); e != nil {
			return nil, e
		}
		if e = tx.QueryRow(ctx, "SELECT count(*) "+registrationJoin+population+filtered, values...).Scan(&matching); e != nil {
			return nil, e
		}
		if total > 9007199254740991 || matching > 9007199254740991 {
			return nil, fail("registered_directory_count_unavailable", 503)
		}
		limit, offset := arg(x["pageSize"]), arg((integer(x["page"])-1)*integer(x["pageSize"]))
		order := "DESC"
		if x["sort"] == "registered-asc" {
			order = "ASC"
		}
		rows, e := many(ctx, tx, "SELECT to_jsonb(q) FROM(SELECT "+columns+" "+registrationJoin+population+filtered+" ORDER BY e.registered_at "+order+" NULLS LAST,s.id ASC LIMIT "+limit+" OFFSET "+offset+")q", values...)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		for _, r := range rows {
			items = append(items, s.item(r, nil, readIdentity, nil))
		}
		pagination["total"], pagination["matchingTotal"], pagination["totalPages"] = total, matching, int64(math.Ceil(float64(matching)/float64(integer(x["pageSize"]))))
		return Object{"items": items, "pagination": pagination, "source": source, "permissions": permissions}, nil
	})
}
func (s *Service) targetWithin(ctx context.Context, q Querier, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, invalid()
	}
	sql := `SELECT to_jsonb(q) FROM(SELECT ` + columns + ` FROM operations_registered_subjects_v1 s LEFT JOIN operations_registered_directory_v1 d ON d.endpoint=s.endpoint LEFT JOIN operations_registered_entries_v1 e ON e.registration_id=s.id AND e.generation_id=d.generation_id LEFT JOIN community_accounts a ON a.endpoint=s.endpoint AND a.issuer=s.issuer AND a.external_subject=s.external_subject LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id LEFT JOIN official_account_registrations_v1 r ON r.endpoint=s.endpoint AND r.issuer=s.issuer AND r.external_subject=s.external_subject WHERE s.endpoint=$1 AND s.id=$2)q`
	row, e := optionalObject(ctx, q, sql, s.Endpoint, id)
	if e == nil && row == nil {
		return nil, fail("registered_user_not_found", 404)
	}
	return row, e
}
func (s *Service) native(ctx context.Context, row Object) (*User, string) {
	if s.Directory == nil {
		return nil, "not-configured"
	}
	if row["issuer"] != s.Directory.Issuer() {
		return nil, "outside-configured-issuer"
	}
	u, e := s.Directory.Get(ctx, str(row["issuer"]), str(row["external_subject"]))
	if e != nil || u != nil && (u.Issuer != row["issuer"] || u.ExternalSubject != row["external_subject"]) {
		return nil, "unavailable"
	}
	if u == nil {
		return nil, "not-found"
	}
	return u, "available"
}
