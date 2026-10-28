// Package operationsanalytics retains the original account usage and normal
// public-use profile summaries. OpenPanel remains the native analytics engine.
package operationsanalytics

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math"
	"strings"
	"time"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type Service struct {
	Domain               *businessadmin.Domain
	Runtime              *discovery.Runtime
	AccountWithin        func(context.Context, pgx.Tx, string, bool) (Object, error)
	PublicActivityWithin func(context.Context, pgx.Tx, int64, int, *string) (Object, error)
}

func fail(c string, s int) error { return fault.New(c, s) }
func str(v any) string           { s, _ := v.(string); return s }
func obj(v any) Object           { o, _ := v.(map[string]any); return o }
func list(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	if a, ok := v.([]Object); ok {
		out := []any{}
		for _, v := range a {
			out = append(out, v)
		}
		return out
	}
	return nil
}
func has(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}
func num(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0
	case int:
		return float64(n), n >= 0
	case int64:
		return float64(n), n >= 0
	case json.Number:
		f, e := n.Float64()
		return f, e == nil && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0
	}
	return 0, false
}
func integer(v any) (int64, bool) {
	f, ok := num(v)
	return int64(f), ok && f == math.Trunc(f) && f <= 9007199254740991
}
func count(v any) int64 { n, _ := integer(v); return n }
func number(v any) any {
	f, ok := num(v)
	if !ok {
		return nil
	}
	return f
}
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func iso(v any) any {
	if v == nil {
		return nil
	}
	if t, ok := v.(time.Time); ok {
		return stamp(t)
	}
	t, e := time.Parse(time.RFC3339Nano, str(v))
	if e != nil {
		return nil
	}
	return stamp(t)
}
func (s *Service) now() int64 {
	if s.Domain.Now != nil {
		return s.Domain.Now().Unix()
	}
	return time.Now().Unix()
}
func parseDays(q Object) (int, error) {
	for k := range q {
		if k != "days" {
			return 0, fail("invalid_business_admin_request", 400)
		}
	}
	if v, ok := q["days"]; ok {
		n, ok := integer(v)
		if !ok || n != 7 && n != 28 {
			return 0, fail("invalid_business_admin_request", 400)
		}
		return int(n), nil
	}
	return 7, nil
}
func validID(s string) bool {
	u, e := uuid.Parse(s)
	return e == nil && len(s) == 36 && (u == uuid.Nil || u == uuid.Max || u.Variant() == uuid.RFC4122 && u.Version() >= 1 && u.Version() <= 8)
}
func period(at int64, days int) (Object, []string) {
	start := int64(math.Floor(float64(at+8*3600)/86400))*86400 - 8*3600 - int64(days-1)*86400
	dates := []string{}
	for i := 0; i < days; i++ {
		dates = append(dates, time.Unix(start+int64(i)*86400+8*3600, 0).UTC().Format("2006-01-02"))
	}
	return Object{"from": stamp(time.Unix(start, 0)), "to": stamp(time.Unix(at, 0)), "timeZone": "Asia/Shanghai"}, dates
}
func rows(ctx context.Context, tx pgx.Tx, q string, args ...any) ([]Object, error) {
	rr, e := tx.Query(ctx, q, args...)
	if e != nil {
		return nil, e
	}
	defer rr.Close()
	out := []Object{}
	for rr.Next() {
		var raw []byte
		if e = rr.Scan(&raw); e != nil {
			return nil, e
		}
		var v Object
		if e = protocol.Decode(raw, &v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rr.Err()
}
func (s *Service) current(ctx context.Context, a Actor, account string) (Actor, error) {
	if s == nil || s.Domain == nil || s.AccountWithin == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Domain.Pool, func(tx pgx.Tx) (Actor, error) {
		fresh, e := s.Domain.Fresh(ctx, tx, a, "analytics.read")
		if e != nil {
			return fresh, e
		}
		if account != "" {
			_, e = s.AccountWithin(ctx, tx, account, false)
		}
		return fresh, e
	})
}
func (s *Service) DirectorySummary(ctx context.Context, a Actor, input Object) (Object, error) {
	days, e := parseDays(input)
	if e != nil {
		return nil, e
	}
	fresh, e := s.current(ctx, a, "")
	if e != nil {
		return nil, e
	}
	at := s.now()
	window, _ := period(at, days)
	return postgres.InTx(ctx, s.Domain.Pool, func(tx pgx.Tx) (Object, error) {
		rr, e := rows(ctx, tx, `SELECT to_jsonb(q) FROM(SELECT count(*)::integer AS accounts,count(*) FILTER(WHERE p.subject_type='person')::integer AS person,count(*) FILTER(WHERE p.subject_type='agent')::integer AS agent,count(*) FILTER(WHERE p.subject_type='organization')::integer AS organization,count(*) FILTER(WHERE p.subject_type IS NULL)::integer AS unknown,count(*) FILTER(WHERE a.restricted_until>$2::timestamptz)::integer AS restricted FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.endpoint=$1)q`, s.Domain.Endpoint, time.Unix(at, 0))
		if e != nil {
			return nil, e
		}
		total := rr[0]
		if e = s.Domain.Record(ctx, tx, fresh, "users-query", Object{"view": "directory-summary", "days": days}, Object{"count": total["accounts"]}, nil); e != nil {
			return nil, e
		}
		total["active"] = nil
		return Object{"checkedAt": at, "days": days, "period": window, "coverage": "business-service-accounts", "totals": total}, nil
	})
}
func (s *Service) AccountSummary(ctx context.Context, a Actor, account string, input Object) (Object, error) {
	days, e := parseDays(input)
	if e != nil || !validID(account) {
		return nil, fail("invalid_business_admin_request", 400)
	}
	account = strings.ToLower(account)
	fresh, e := s.current(ctx, a, account)
	if e != nil {
		return nil, e
	}
	usage, e := s.Usage(ctx, fresh, account, Object{"days": days})
	if e != nil {
		return nil, e
	}
	profile, e := s.Profile(ctx, fresh, account, Object{"days": days})
	if e != nil {
		return nil, e
	}
	at := s.now()
	window, dates := period(at, days)
	tx, e := s.Domain.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	if _, e = s.AccountWithin(ctx, tx, account, false); e != nil {
		return nil, e
	}
	if s.PublicActivityWithin == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	activity, e := s.PublicActivityWithin(ctx, tx, at, days, &account)
	if e != nil {
		return nil, e
	}
	current, e := s.Domain.Fresh(ctx, tx, fresh, "analytics.read")
	if e != nil {
		return nil, e
	}
	if e = s.Domain.RecordAccountRead(ctx, tx, fresh, "user-read", Object{"view": "usage-summary", "days": days}, Object{"publicActivityState": activity["state"]}, account); e != nil {
		return nil, e
	}
	var contributions any
	daily := []Object{}
	if activity["available"] == true {
		contributions = count(obj(activity["totals"])["posts"]) + count(obj(activity["totals"])["replies"])
		for _, r := range list(activity["daily"]) {
			v := obj(r)
			daily = append(daily, Object{"date": v["date"], "count": count(v["posts"]) + count(v["replies"])})
		}
	} else {
		for _, date := range dates {
			daily = append(daily, Object{"date": date, "count": nil})
		}
	}
	recommendations := obj(profile["recommendations"])
	if !has(current.Permissions, "recommendations.read") {
		recommendations["state"], recommendations["categories"], recommendations["updatedAt"] = "not-authorized", []any{}, nil
		basis := obj(recommendations["basis"])
		basis["complete"], basis["reasonCodes"] = false, []string{"not-authorized"}
	}
	expires := at + 30
	for _, value := range []Object{usage, profile} {
		if n := count(value["readExpiresAt"]); n < expires {
			expires = n
		}
	}
	out := Object{"accountId": account, "checkedAt": at, "readExpiresAt": expires, "days": days, "period": window, "usageAnalysis": usage, "usage": Object{"activeDays": nil, "searches": nil, "bookmarks": nil, "participation": nil, "publicContributions": contributions, "lastActivityAt": activity["lastActivityAt"], "dailyActivity": daily, "basis": activity["basis"], "publicActivityState": activity["state"], "publicActivityReason": activity["reason"]}, "profile": profile["profile"], "predictions": Object{"participation": Object{"state": "not-analyzed", "label": nil, "summary": nil}, "needs": Object{"state": "not-analyzed", "label": nil, "summary": nil}}, "recommendations": recommendations}
	return out, tx.Commit(ctx)
}
