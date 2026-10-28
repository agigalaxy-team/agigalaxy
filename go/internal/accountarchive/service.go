// Package accountarchive stores only explicitly selected private copies of local
// work and conversations in the original account ledgers.
package accountarchive

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor struct {
	Device               deviceauth.Actor
	AccountID, RequestID string
	// Official is supplied only by the verified portal identity adapter.
	Official         bool
	Endpoint         string
	AuthorizeAccount func(context.Context, pgx.Tx, string, string) error
}
type Registry interface {
	ResolveWithin(context.Context, pgx.Tx, deviceauth.Actor, string, bool) (Object, error)
	AvailableWithin(context.Context, pgx.Tx, deviceauth.Actor) ([]Object, error)
}
type DeviceAuthorization interface {
	AuthorizeWithin(context.Context, pgx.Tx, deviceauth.Actor, string) error
}

// ResourceWrite takes the original budget lock, calls authorize, samples usage,
// calls operation, and enforces the before/after delta in this transaction.
// Keeping authorize separate preserves budget -> subject -> mapping lock order.
type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, func() error, func() (Object, error)) (Object, error)
type Service struct {
	Pool          *pgxpool.Pool
	Endpoint      string
	Now           func() time.Time
	Devices       DeviceAuthorization
	Registry      Registry
	ResourceWrite ResourceWrite
	Profiles      *accounts.Service
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func validID(v string) bool { return uuidPattern.MatchString(v) }
func origin(a Actor) any {
	if a.Official {
		return nil
	}
	return a.Device.SubjectID
}
func (s *Service) run(ctx context.Context, a Actor, write, resource bool, fn func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	if !validID(a.AccountID) {
		return nil, fault.New("account_selection_required", 409)
	}
	if s.Pool == nil {
		return nil, fault.New("account_work_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		authorize := func() error {
			if a.Official {
				if a.Endpoint != s.Endpoint || a.AuthorizeAccount == nil {
					return fault.New("access_denied", 401)
				}
				if e := a.AuthorizeAccount(ctx, tx, s.Endpoint, a.AccountID); e != nil {
					return e
				}
				query := `SELECT id FROM community_accounts WHERE id=$1 AND endpoint=$2`
				if write {
					query += " FOR UPDATE"
				}
				var id string
				if e := tx.QueryRow(ctx, query, a.AccountID, s.Endpoint).Scan(&id); e != nil {
					if absentRow(e) {
						return fault.New("account_target_unavailable", 403)
					}
					return e
				}
			} else {
				if !subjectPattern.MatchString(a.Device.SubjectID) || s.Devices == nil || s.Registry == nil {
					return fault.New("access_denied", 401)
				}
				if e := s.Devices.AuthorizeWithin(ctx, tx, a.Device, "binding"); e != nil {
					return e
				}
				target, e := s.Registry.ResolveWithin(ctx, tx, a.Device, a.AccountID, write)
				if e != nil {
					return e
				}
				a.AccountID = str(target, "id")
			}
			return nil
		}
		operation := func() (Object, error) {
			result, e := fn(tx, a)
			if e != nil {
				return nil, e
			}
			if a.Official {
				if e = a.AuthorizeAccount(ctx, tx, s.Endpoint, a.AccountID); e != nil {
					return nil, e
				}
			}
			return result, nil
		}
		if resource && !a.Official && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, a.Device, authorize, operation)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return operation()
	})
}
func (s *Service) Accounts(ctx context.Context, a Actor, raw []byte) (Object, error) {
	if _, e := input(raw, "invalid_account_data", nil); e != nil {
		return nil, e
	}
	if s.Pool == nil || s.Devices == nil || s.Registry == nil {
		return nil, fault.New("account_work_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.Devices.AuthorizeWithin(ctx, tx, a.Device, "binding"); e != nil {
			return nil, e
		}
		rows, e := s.Registry.AvailableWithin(ctx, tx, a.Device)
		if e != nil {
			return nil, e
		}
		views := []Object{}
		for _, r := range rows {
			views = append(views, accountlinks.View(r, ""))
		}
		return Object{"accounts": views, "subjectId": a.Device.SubjectID}, nil
	})
}
func (s *Service) ensure(ctx context.Context, tx pgx.Tx, id string) error {
	p := s.Profiles
	if p == nil {
		p = &accounts.Service{Endpoint: s.Endpoint, Now: s.Now}
	}
	_, e := p.EnsureProfileWithin(ctx, tx, id, nil)
	return e
}
func input(raw []byte, code string, keys []string) (Object, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || o == nil {
		return nil, fault.New(code, 400)
	}
	for k := range o {
		found := false
		for _, key := range keys {
			if key == k {
				found = true
				break
			}
		}
		if !found {
			return nil, fault.New(code, 400)
		}
	}
	return o, nil
}
func str(o Object, k string) string { v, _ := o[k].(string); return v }
func number(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, e := n.Float64()
	if e != nil || f < 0 || f > 9007199254740991 || float64(int64(f)) != f {
		return 0, false
	}
	return int64(f), true
}
func integer(o Object, k string, min, max int64) (int64, bool) {
	n, ok := number(o[k])
	return n, ok && n >= min && n <= max
}
func text(v any, min, max int) bool {
	s, ok := v.(string)
	return ok && protocol.TextLength(s) >= min && protocol.TextLength(s) <= max
}
func absentRow(e error) bool { return errors.Is(e, pgx.ErrNoRows) }
func encoded(v any) []byte   { b, _ := protocol.Encode(v); return b }
