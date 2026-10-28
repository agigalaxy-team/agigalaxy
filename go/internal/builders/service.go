// Package builders owns the existing registry and runner-reported PackUse
// ledgers. A declaration, reference or successful receipt proves no execution.
package builders

import (
	"context"
	"encoding/json"
	"errors"
	"time"

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
)

type Object = map[string]any
type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type Service struct {
	Pool                *pgxpool.Pool
	Endpoint            string
	Devices             *deviceauth.Service
	Now                 func() time.Time
	ResourceWrite       ResourceWrite
	Cases               *cases.Service
	Configurations      *configurations.Service
	VerificationRecords *verificationrecords.Service
	Proofs              *evidence.ProofService
	AssessorIDs         []string
	SuitePins           []Object
	SignConformance     func(context.Context, string, any, string, int64) (string, error)
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func obj(v any) Object {
	if v, ok := v.(*protocol.OrderedObject); ok {
		return v.Values()
	}
	vmap, _ := v.(map[string]any)
	return vmap
}
func txt(o Object, k string) string { s, _ := o[k].(string); return s }
func num(o Object, k string) int64 {
	switch v := o[k].(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case int32:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		f, _ := v.Float64()
		return int64(f)
	}
	return 0
}
func arr(v any) []any { a, _ := v.([]any); return a }
func contains(values []string, v string) bool {
	for _, item := range values {
		if item == v {
			return true
		}
	}
	return false
}
func clone(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func nullable(v any) any {
	if v == nil {
		return nil
	}
	return v
}
func missing(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422 || f.Status == 503)
}
func domainError(e error) bool { var f *fault.Error; return errors.As(e, &f) }
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
		item := Object{}
		for i, field := range rows.FieldDescriptions() {
			v := values[i]
			if raw, ok := v.([16]byte); ok {
				v = pgUUID(raw)
			}
			item[field.Name] = v
		}
		out = append(out, item)
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
func pgUUID(v [16]byte) string { return uuid.UUID(v).String() }
func (s *Service) run(ctx context.Context, a *deviceauth.Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil {
		return nil, fault.New("builder_service_unavailable", 503)
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
				return fault.New("builder_service_unavailable", 503)
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
		op := func() (Object, error) { return fn(tx, auth) }
		if write && a != nil && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, *a, control, authorize, op)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return op()
	})
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, row Object, packUse bool) (deviceauth.ConsentIntent, error) {
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("builder_service_unavailable", 503)
	}
	key := "id"
	if packUse {
		key = "operation_id"
	}
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: txt(row, "consent_id"), SubjectID: txt(row, "subject_id"), Action: "builder.publish", ObjectID: txt(row, key), Recipient: s.Endpoint, PayloadJSON: txt(row, "payload_text")})
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
		return contains(g.Viewers, a.SubjectID)
	}
	return false
}

type loadedBuilder struct {
	parent      Object
	rows        []Object
	declaration Object
}

func (s *Service) load(ctx context.Context, tx pgx.Tx, id string, write bool) (loadedBuilder, error) {
	lock := "SHARE"
	if write {
		lock = "UPDATE"
	}
	parent, e := one(ctx, tx, "SELECT id::text,owner_id,type,revision FROM builders WHERE id=$1 FOR "+lock, id)
	if e != nil {
		return loadedBuilder{}, e
	}
	if parent == nil {
		return loadedBuilder{}, fault.New("builder_unavailable", 404)
	}
	rows, e := query(ctx, tx, "SELECT id::text,builder_id::text,subject_id,revision,kind,consent_id::text,payload_text,payload_hash,received_at FROM builder_events WHERE builder_id=$1 ORDER BY revision", id)
	loaded := loadedBuilder{parent: parent, rows: rows}
	for _, row := range rows {
		if row["kind"] == "declare" {
			loaded.declaration = row
		}
	}
	return loaded, e
}
func event(row Object) Object {
	var v Object
	if txt(row, "payload_text") == "" || protocol.Decode([]byte(txt(row, "payload_text")), &v) != nil {
		return nil
	}
	return v
}
func (s *Service) current(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, b loadedBuilder) (Object, deviceauth.ConsentIntent, error) {
	if b.declaration == nil {
		return nil, deviceauth.ConsentIntent{}, fault.New("builder_unavailable", 404)
	}
	g, e := s.grant(ctx, tx, b.declaration, false)
	if e != nil {
		return nil, g, e
	}
	if !s.visible(g, a) {
		return nil, g, fault.New("builder_unavailable", 404)
	}
	v := event(b.declaration)
	if v == nil {
		return nil, g, fault.New("builder_unavailable", 404)
	}
	return obj(v["declaration"]), g, nil
}
func maintenance(rows []Object) Object {
	out := Object{"delisted": false, "securityIssue": false}
	for _, row := range rows {
		if row["kind"] != "maintenance" {
			continue
		}
		switch event(row)["action"] {
		case "delist":
			out["delisted"] = true
		case "relist":
			out["delisted"] = false
		case "security-issue":
			out["securityIssue"] = true
		case "resolve-security":
			out["securityIssue"] = false
		}
	}
	return out
}
func latest(rows []Object, kind string) Object {
	var found Object
	for _, row := range rows {
		if row["kind"] == kind {
			found = row
		}
	}
	return found
}
