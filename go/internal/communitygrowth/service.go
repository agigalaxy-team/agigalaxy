package communitygrowth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type Service struct {
	Pool                *pgxpool.Pool
	Endpoint            string
	Now                 func() time.Time
	Authority           *operationspermissions.BusinessAuthority
	Forum               *community.Service
	WorkerPublicRead    bool
	PublicAccountWithin func(context.Context, pgx.Tx, string, string) (Object, error)
	OnSourceWithin      func(context.Context, pgx.Tx, Source) error
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func invalid() error                { return fault.New("community_growth_invalid_request", 400) }
func str(o Object, k string) string { v, _ := o[k].(string); return strings.TrimSpace(v) }
func jsonText(v any) string         { b, _ := json.Marshal(v); return string(b) }
func (s *Service) require(ctx context.Context, tx pgx.Tx, a Actor, permission string) (Actor, error) {
	if s.Authority == nil {
		return Actor{}, fault.New("operations_authorization_unavailable", 503)
	}
	if a.ID == "" || a.Endpoint != s.Endpoint {
		return Actor{}, fault.New("business_admin_denied", 403)
	}
	fresh, e := s.Authority.RequireWithin(ctx, tx, a, permission)
	if e != nil {
		return Actor{}, e
	}
	if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint {
		return Actor{}, fault.New("business_admin_denied", 403)
	}
	return fresh, nil
}
func noRows(e error) bool { return errors.Is(e, pgx.ErrNoRows) }
func rowsObjects(rows pgx.Rows) ([]Object, error) {
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var x Object
		if e := rows.Scan(&x); e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
