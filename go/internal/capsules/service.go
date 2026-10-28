// Package capsules owns the existing registered method publications and uses.
// Reading a method never establishes reuse, causality, or individual capability.
package capsules

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Object = map[string]any
type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type SelectedReader func(context.Context, pgx.Tx, *deviceauth.Actor, Object) (Object, error)
type MaterialReader func(context.Context, pgx.Tx, *deviceauth.Actor, string) (Object, error)
type Service struct {
	Pool                 *pgxpool.Pool
	Endpoint             string
	Devices              *deviceauth.Service
	Cases                *cases.Service
	Records              *verificationrecords.Service
	Proofs               *evidence.ProofService
	Configurations       *configurations.Service
	Selected             SelectedReader
	Materials            MaterialReader
	ResourceWrite        ResourceWrite
	OperationsVisibility func(context.Context, pgx.Tx, string) (bool, error)
	Now                  func() time.Time
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func encode(v any) []byte {
	b, e := protocol.EncodeJS(v)
	if e != nil {
		panic(e)
	}
	return b
}
func obj(v any) Object {
	if o, ok := v.(Object); ok {
		return o
	}
	if o, ok := v.(*protocol.OrderedObject); ok {
		return o.Values()
	}
	return nil
}
func list(v any) []any {
	if x, ok := v.([]any); ok {
		return x
	}
	if x, ok := v.([]Object); ok {
		out := make([]any, len(x))
		for i := range x {
			out[i] = x[i]
		}
		return out
	}
	return nil
}
func text(o Object, k string) string { v, _ := o[k].(string); return v }
func number(o Object, k string) int64 {
	switch v := o[k].(type) {
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		x, _ := v.Float64()
		return int64(x)
	}
	return 0
}
func subject(a *deviceauth.Actor) string {
	if a != nil {
		return a.SubjectID
	}
	return ""
}
func absent(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 400 || f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422 || f.Status == 503)
}
func serviceError(e error) bool { var f *fault.Error; return errors.As(e, &f) }
func query(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		v, e := rows.Values()
		if e != nil {
			return nil, e
		}
		o := Object{}
		for i, f := range rows.FieldDescriptions() {
			x := v[i]
			if id, ok := x.([16]byte); ok {
				x = uuid.UUID(id).String()
			}
			o[f.Name] = x
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func one(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	r, e := query(ctx, tx, sql, args...)
	if e != nil || len(r) == 0 {
		return nil, e
	}
	return r[0], nil
}
func (s *Service) run(ctx context.Context, a *deviceauth.Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("capsule_unavailable", 503)
	}
	if write {
		if a == nil {
			return nil, fault.New("access_denied", 401)
		}
		if e := deviceauth.CheckInformationWatchWrite(*a, "capsules"); e != nil {
			return nil, e
		}
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error {
			if a == nil {
				return nil
			}
			if s.Devices == nil {
				return fault.New("capsule_unavailable", 503)
			}
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, *a, "capsules")
			return e
		}
		op := func() (Object, error) { return fn(tx, auth) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, *a, control, authorize, op)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return op()
	})
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, row Object, action string) (deviceauth.ConsentIntent, error) {
	if text(row, "payload_text") == "" {
		return deviceauth.ConsentIntent{}, fault.New("capsule_source_unavailable", 404)
	}
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("capsule_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: text(row, "consent_id"), SubjectID: text(row, "subject_id"), ObjectID: text(row, "id"), Action: action, Recipient: s.Endpoint, PayloadJSON: text(row, "payload_text")})
}
func (s *Service) visible(g deviceauth.ConsentIntent, a *deviceauth.Actor) bool {
	if g.IssuedAt > s.now() || g.ExpiresAt <= s.now() {
		return false
	}
	if subject(a) == g.SubjectID {
		return true
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return false
	}
	if g.Visibility == "Public" {
		return g.Purpose == "public-profile"
	}
	if a != nil && (g.Visibility == "Private" || g.Visibility == "Hub-scoped" && g.Recipient == s.Endpoint) {
		for _, v := range g.Viewers {
			if v == a.SubjectID {
				return true
			}
		}
	}
	return false
}
func parseStored(row Object) (*protocol.OrderedObject, error) {
	o, e := protocol.DecodeOrdered([]byte(text(row, "payload_text")))
	if e != nil {
		return nil, e
	}
	value, ok := o.(*protocol.OrderedObject)
	if !ok {
		return nil, fault.New("invalid_capsule_payload", 400)
	}
	return value, nil
}
