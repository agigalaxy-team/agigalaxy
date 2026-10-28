// Package hubs preserves the original Hub charter and explicit membership
// authority. Joining a Hub grants no ambient task, identity or content access.
package hubs

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Object = map[string]any
type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type Service struct {
	Pool          *pgxpool.Pool
	Endpoint      string
	Devices       *deviceauth.Service
	Builders      *builders.Service
	Now           func() time.Time
	ResourceWrite ResourceWrite
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
func arr(v any) []any               { a, _ := v.([]any); return a }
func txt(v Object, k string) string { x, _ := v[k].(string); return x }
func num(v Object, k string) int64 {
	switch x := v[k].(type) {
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
func flag(v Object) Object {
	for _, key := range []string{"identityChanged", "taskAccessGranted", "capabilityVerified", "autonomousDomainVerified", "relayEnabled"} {
		v[key] = false
	}
	return v
}
func require(yes bool, code string, status int) error {
	if !yes {
		return fault.New(code, status)
	}
	return nil
}
func unavailable() error  { return fault.New("hub_unavailable", 404) }
func domain(e error) bool { var f *fault.Error; return errors.As(e, &f) }
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
func event(row Object) Object {
	var v Object
	if txt(row, "payload_text") == "" || protocol.Decode([]byte(txt(row, "payload_text")), &v) != nil {
		return nil
	}
	return v
}
func (s *Service) run(ctx context.Context, a *deviceauth.Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("hub_service_unavailable", 503)
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
				return fault.New("hub_service_unavailable", 503)
			}
			if write {
				if e := deviceauth.CheckInformationWatchWrite(*a, "builders"); e != nil {
					return e
				}
			}
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, *a, "builders")
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
func (s *Service) head(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	lock := "SHARE"
	if write {
		lock = "UPDATE"
	}
	v, e := one(ctx, tx, "SELECT * FROM hub_heads_v2 WHERE id=$1 FOR "+lock, id)
	if e != nil {
		return nil, e
	}
	if v == nil {
		return nil, unavailable()
	}
	return v, nil
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, row Object) (deviceauth.ConsentIntent, error) {
	if txt(row, "payload_text") == "" {
		return deviceauth.ConsentIntent{}, unavailable()
	}
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("hub_service_unavailable", 503)
	}
	g, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: txt(row, "consent_id"), SubjectID: txt(row, "subject_id"), Action: "hub.publish", ObjectID: txt(row, "id"), Recipient: s.Endpoint, PayloadJSON: txt(row, "payload_text")})
	if e != nil {
		return g, e
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return g, unavailable()
	}
	return g, nil
}
func (s *Service) visible(g deviceauth.ConsentIntent, a *deviceauth.Actor) bool {
	if g.IssuedAt > s.now() || g.ExpiresAt <= s.now() {
		return false
	}
	if a != nil && a.SubjectID == g.SubjectID {
		return true
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return false
	}
	if g.Visibility == "Public" {
		return g.Purpose == "public-profile"
	}
	if a != nil && (g.Visibility == "Private" || g.Visibility == "Hub-scoped" && g.Recipient == s.Endpoint) {
		for _, id := range g.Viewers {
			if id == a.SubjectID {
				return true
			}
		}
	}
	return false
}
func (s *Service) readable(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, row Object) (bool, error) {
	g, e := s.grant(ctx, tx, row)
	if e != nil {
		if domain(e) {
			return false, nil
		}
		return false, e
	}
	return s.visible(g, a), nil
}
func (s *Service) charter(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, head Object, version any) (Object, error) {
	if version == nil {
		version = head["version"]
	}
	row, e := one(ctx, tx, "SELECT * FROM hub_events_v2 WHERE hub_id=$1 AND charter_version=$2 AND kind='charter'", head["id"], version)
	if e != nil {
		return nil, e
	}
	read, e := s.readable(ctx, tx, a, row)
	if e != nil {
		return nil, e
	}
	if !read {
		return nil, unavailable()
	}
	return row, nil
}
func (s *Service) registry(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (builders.RegistrySource, error) {
	if s.Builders == nil {
		return builders.RegistrySource{}, fault.New("hub_builder_unavailable", 503)
	}
	return s.Builders.RegistryWithin(ctx, tx, a, id)
}
func (s *Service) current(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, Object, error) {
	h, e := s.head(ctx, tx, id, false)
	if e != nil {
		return nil, nil, e
	}
	c, e := s.charter(ctx, tx, a, h, nil)
	if e != nil {
		return nil, nil, e
	}
	b, e := s.registry(ctx, tx, a, id)
	if e != nil {
		return nil, nil, e
	}
	p := event(c)
	if h["state"] != "active" || b.Maintenance["delisted"] == true || b.Maintenance["securityIssue"] == true || b.DeclarationEvent["id"] != p["declarationId"] || b.DeclarationEvent["payload_hash"] != p["declarationHash"] {
		return nil, nil, fault.New("hub_current_scope_unavailable", 409)
	}
	return h, c, nil
}
func Specification() Object {
	var v Object
	_ = protocol.Decode([]byte(specificationJSON), &v)
	return v
}
