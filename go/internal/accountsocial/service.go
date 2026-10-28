// Package accountsocial preserves private follows and saved source locators.
// Neither choice creates a source-reading, notification, contact or room grant.
package accountsocial

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor struct {
	Device                         deviceauth.Actor
	AccountID, Endpoint, RequestID string
	Official                       bool
	Authority                      accounts.Authorization
}
type ForumReader interface {
	ReadBookmarkWithin(context.Context, pgx.Tx, string, community.Authorization, *deviceauth.Actor, string) (Object, error)
}

// SourceReader is an owning domain's existing current-authorized read, not a
// metadata lookup. Nil readers preserve the original temporary failure state.
type SourceReader func(context.Context, pgx.Tx, Actor, Reference) (Object, error)
type Service struct {
	Pool                               *pgxpool.Pool
	Endpoint                           string
	Now                                func() time.Time
	Devices                            *deviceauth.Service
	Links                              *accountlinks.Service
	Accounts                           *accounts.Service
	Resources                          *resourcebudget.Service
	Forum                              ForumReader
	Capsules, Projects, Profiles, Chat SourceReader
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func stamp(t time.Time) string         { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func encode(v any) []byte              { b, _ := protocol.Encode(v); return b }
func str(o Object, k string) string    { v, _ := o[k].(string); return v }
func object(o Object, k string) Object { v, _ := o[k].(map[string]any); return v }

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validID(v string) bool { return uuidPattern.MatchString(v) }
func number(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, e := n.Float64()
	return int64(f), e == nil && f >= 0 && f <= 9007199254740991 && float64(int64(f)) == f
}
func num(o Object, k string) int64 { v, _ := number(o[k]); return v }
func date(v any) any {
	if v == nil {
		return nil
	}
	t, e := time.Parse(time.RFC3339Nano, v.(string))
	if e != nil {
		return v
	}
	return stamp(t)
}
func row(ctx context.Context, tx pgx.Tx, query string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, "SELECT row_to_json(r) FROM ("+query+") r", args...).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var out Object
	e = protocol.Decode(raw, &out)
	return out, e
}
func rows(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]Object, error) {
	rr, e := tx.Query(ctx, "SELECT row_to_json(r) FROM ("+query+") r", args...)
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
		var r Object
		if e = protocol.Decode(raw, &r); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rr.Err()
}
func shape(raw []byte, required, optional []string, code string) (Object, error) {
	var p Object
	if protocol.Decode(raw, &p) != nil || p == nil {
		return nil, fault.New(code, 400)
	}
	for k := range p {
		found := false
		for _, v := range append(append([]string{}, required...), optional...) {
			if k == v {
				found = true
			}
		}
		if !found {
			return nil, fault.New(code, 400)
		}
	}
	for _, k := range required {
		if _, ok := p[k]; !ok {
			return nil, fault.New(code, 400)
		}
	}
	return p, nil
}
func (s *Service) run(ctx context.Context, a Actor, account, write bool, fn func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("reading_bookmark_reader_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		authorize := func(context.Context, pgx.Tx) error {
			if a.Official {
				if !account || a.Endpoint != s.Endpoint || !validID(a.AccountID) || a.Authority == nil {
					return fault.New("official_account_login_required", 401)
				}
				if s.Links == nil {
					return fault.New("reading_bookmark_reader_unavailable", 503)
				}
				target, e := s.Links.ResolvePortalWithin(ctx, tx, a.Authority, a.Endpoint, a.AccountID, a.AccountID, write)
				if e != nil {
					return e
				}
				a.AccountID = str(target, "id")
			} else {
				if s.Devices == nil {
					return fault.New("access_denied", 401)
				}
				if e := s.Devices.AuthorizeWithin(ctx, tx, a.Device, "binding"); e != nil {
					return e
				}
				if account {
					if s.Links == nil {
						return fault.New("reading_bookmark_reader_unavailable", 503)
					}
					target, e := s.Links.ResolveWithin(ctx, tx, a.Device, a.AccountID, write)
					if e != nil {
						return e
					}
					a.AccountID = str(target, "id")
				}
				// Each source reader rechecks its own current grant. Never use an old
				// credential's removed scopes to turn an anonymous read into an ID read.
				scopes := []string{}
				seen := map[string]bool{}
				for _, scope := range append([]string{"binding"}, a.Device.Scopes...) {
					if seen[scope] {
						continue
					}
					seen[scope] = true
					if e := s.Devices.AuthorizeWithin(ctx, tx, a.Device, scope); e == nil {
						scopes = append(scopes, scope)
					} else if fault.Code(e) != "access_denied" {
						return e
					}
				}
				a.Device.Scopes = scopes
			}
			return nil
		}
		operation := func(context.Context, pgx.Tx) (any, error) {
			out, e := fn(tx, a)
			if e != nil {
				return nil, e
			}
			if a.Official {
				if e = a.Authority.Account(ctx, tx, s.Endpoint, a.AccountID); e != nil {
					return nil, e
				}
			}
			return out, nil
		}
		if write && !a.Official && s.Resources != nil {
			v, e := s.Resources.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.Device.SubjectID}, authorize, operation, resourcebudget.Options{Control: account})
			if e != nil {
				return nil, e
			}
			return v.(Object), nil
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		v, e := operation(ctx, tx)
		if e != nil {
			return nil, e
		}
		return v.(Object), nil
	})
}
