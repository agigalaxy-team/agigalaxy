// Package identitygroups preserves explicit canonical-display relationships.
// Original identities, source rights and capabilities never merge with a group.
package identitygroups

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

const SignatureType = "galaxy-identity-group-v2+jws"

type Object = map[string]any
type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type Service struct {
	Pool           *pgxpool.Pool
	Endpoint       string
	Devices        *deviceauth.Service
	Cases          *cases.Service
	Configurations *configurations.Service
	Now            func() time.Time
	ResourceWrite  ResourceWrite
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func obj(v any) Object {
	if o, ok := v.(*protocol.OrderedObject); ok {
		return o.Values()
	}
	o, _ := v.(Object)
	return o
}
func arr(v any) []any { x, _ := v.([]any); return x }
func txt(v Object, key string) string {
	switch x := v[key].(type) {
	case string:
		return x
	case jstext.String:
		return x.Decoded()
	}
	return ""
}
func num(v Object, key string) int64 {
	switch x := v[key].(type) {
	case int:
		return int64(x)
	case int32:
		return int64(x)
	case int64:
		return x
	case float64:
		return int64(x)
	case json.Number:
		f, _ := x.Float64()
		return int64(f)
	}
	return 0
}
func has(values []any, value any) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func clone(v Object) Object {
	out := Object{}
	for k, x := range v {
		out[k] = x
	}
	return out
}
func rule(ok bool, code string, status int) error {
	if !ok {
		return fault.New(code, status)
	}
	return nil
}
func unavailable(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 401 || f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422)
}
func query(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		values, e := rows.Values()
		if e != nil {
			return nil, e
		}
		row := Object{}
		for i, f := range rows.FieldDescriptions() {
			v := values[i]
			if id, ok := v.([16]byte); ok {
				v = uuid.UUID(id).String()
			}
			row[f.Name] = v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
func one(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	rows, e := query(ctx, tx, sql, args...)
	if e != nil || len(rows) == 0 {
		return nil, e
	}
	return rows[0], nil
}
func stamp(v any) any {
	if at, ok := v.(time.Time); ok {
		return at.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}
func seconds(v any) int64 {
	if at, ok := v.(time.Time); ok {
		return at.Unix()
	}
	if s, ok := v.(string); ok {
		at, _ := time.Parse(time.RFC3339Nano, s)
		return at.Unix()
	}
	return 0
}
func payload(row Object) Object {
	value, e := jstext.DecodeJSON([]byte(txt(row, "payload_text")))
	if e != nil {
		return nil
	}
	return obj(value)
}
func (s *Service) run(ctx context.Context, a *deviceauth.Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("identity_group_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error {
			if a == nil {
				if write {
					return fault.New("unauthorized", 401)
				}
				return nil
			}
			if s.Devices == nil {
				return fault.New("identity_group_unavailable", 503)
			}
			if write {
				if e := deviceauth.CheckInformationWatchWrite(*a, "binding"); e != nil {
					return e
				}
			}
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, *a, "binding")
			return e
		}
		run := func() (Object, error) { return fn(tx, auth) }
		if write && a != nil && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, *a, control, authorize, run)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return run()
	})
}
func (s *Service) control(ctx context.Context, tx pgx.Tx, a deviceauth.Actor) (deviceauth.ControlAuthorization, error) {
	if s.Devices == nil {
		return deviceauth.ControlAuthorization{}, fault.New("identity_group_unavailable", 503)
	}
	epoch := a.ControlEpoch
	return s.Devices.CurrentSignerWithin(ctx, tx, a.SubjectID, a.DeviceID, a.KeyID, epoch, "manage-identity")
}
func (s *Service) optionalControl(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor) (*deviceauth.ControlAuthorization, error) {
	if a == nil {
		return nil, nil
	}
	c, e := s.control(ctx, tx, *a)
	if e != nil {
		if unavailable(e) {
			return nil, nil
		}
		return nil, e
	}
	return &c, nil
}
func (s *Service) deletionPending(ctx context.Context, tx pgx.Tx, ids []string) (bool, error) {
	row, e := one(ctx, tx, "SELECT 1 FROM deletion_requests WHERE subject_id=ANY($1::text[]) AND state IN ('requested','review-needed','approved','partial','primary-erased') LIMIT 1", ids)
	return row != nil, e
}
func (s *Service) Current(ctx context.Context, a deviceauth.Actor) (Object, error) {
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		c, e := s.control(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		pending, e := s.deletionPending(ctx, tx, []string{a.SubjectID})
		if e != nil {
			return nil, e
		}
		actions := []any{}
		if !pending {
			actions = append(actions, "create")
		}
		return Object{"subjectId": a.SubjectID, "keyId": c.KeyID, "epoch": c.Epoch, "endpoint": s.Endpoint, "checkedAt": s.now(), "signingType": SignatureType, "availableActions": actions}, nil
	})
}
