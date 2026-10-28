// Package taskmaterials retains the existing explicitly selected Task text and
// independently approved outcome copies. Sources keep their own authority.
package taskmaterials

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor struct {
	deviceauth.Actor
	HTTPRequestID *string
}
type Service struct {
	Pool                               *pgxpool.Pool
	Endpoint                           string
	Devices                            *deviceauth.Service
	Resources                          *resourcebudget.Service
	Forum                              ForumSource
	Writes                             *publicwrites.Service
	Links                              *accountlinks.Service
	ValidateParticipationQualification func(context.Context, pgx.Tx, Actor, Object, Object) error
	ValidateDelivery                   func(context.Context, pgx.Tx, Actor, DeliveryInput) error
	LegacyQualification                func(context.Context, pgx.Tx, Actor, Object, string) (Object, error)
	OwnedCaseLive                      func(context.Context, pgx.Tx, deviceauth.Actor, string) error
	CaseOwnerSource                    func(context.Context, pgx.Tx, string, string) error
	ValidateTaskContext                func(context.Context, pgx.Tx, Actor, string, []any) error
	ValidateQualification              func(context.Context, pgx.Tx, Object, string, string) error

	CaseWithin func(context.Context, pgx.Tx, string) (Object, error)

	Now func() time.Time
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func fail(code string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(code, n)
}
func (s *Service) run(ctx context.Context, a Actor, scope string, write, control bool, operation func(pgx.Tx, deviceauth.ControlAuthorization) (any, error)) (any, error) {
	if write {
		if e := deviceauth.CheckInformationWatchWrite(a.Actor, scope); e != nil {
			return nil, e
		}
	}
	if s == nil || s.Pool == nil || s.Devices == nil || s.Endpoint == "" || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("material_service_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, a.Actor, scope)
			return e
		}
		if write {
			resource := s.Resources
			if resource == nil {
				resource, _ = resourcebudget.New(nil, s.Now)
			}
			return resource.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.SubjectID}, authorize, func(context.Context, pgx.Tx) (any, error) { return operation(tx, auth) }, resourcebudget.Options{Control: control})
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		return operation(tx, auth)
	})
}
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var out Object
	e := tx.QueryRow(ctx, sql, args...).Scan(&out)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return out, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		var item Object
		if e = r.Scan(&item); e != nil {
			return nil, e
		}
		out = append(out, item)
	}
	return out, r.Err()
}
func text(v any) string             { s, _ := v.(string); return s }
func str(v Object, k string) string { return text(v[k]) }
func obj(v Object, k string) Object { x, _ := v[k].(map[string]any); return x }
func arr(v any) []any               { x, _ := v.([]any); return x }
func num(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		v, e := n.Int64()
		if e == nil {
			return v
		}
		f, e := n.Float64()
		if e == nil && f >= math.MinInt64 && f < math.MaxInt64 {
			return int64(f)
		}
		return 0
	case string:
		v, _ := strconv.ParseInt(n, 10, 64)
		return v
	}
	return 0
}
func truth(v any) bool { b, _ := v.(bool); return b }
func sec(v any) int64 {
	if n, ok := v.(float64); ok {
		return int64(n)
	}
	t, e := time.Parse(time.RFC3339Nano, text(v))
	if e != nil {
		return 0
	}
	return t.Unix()
}
func stamp(at int64) string  { return time.Unix(at, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
func jsonBytes(v any) []byte { b, _ := protocol.Encode(v); return b }
func canonical(v any) string { b, _ := identity.Canonical(v); return string(b) }
func contains(v []string, x string) bool {
	for _, s := range v {
		if s == x {
			return true
		}
	}
	return false
}
func stringsOf(v any) []string {
	if values, ok := v.([]string); ok {
		return append([]string{}, values...)
	}
	out := []string{}
	for _, x := range arr(v) {
		out = append(out, text(x))
	}
	return out
}

var idPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validID(id string) bool {
	_, e := uuid.Parse(id)
	return e == nil && (idPattern.MatchString(id) || id == "00000000-0000-0000-0000-000000000000" || strings.EqualFold(id, "ffffffff-ffff-ffff-ffff-ffffffffffff"))
}
func parseObject(raw string) (Object, error) {
	var value Object
	if protocol.Decode([]byte(raw), &value) != nil || value == nil {
		return nil, fail("invalid_material_payload", 400)
	}
	return value, nil
}

func exactFields(v Object, required, optional []string) bool {
	for k, value := range v {
		if value == nil || !contains(required, k) && !contains(optional, k) {
			return false
		}
	}
	for _, k := range required {
		if _, ok := v[k]; !ok {
			return false
		}
	}
	return true
}
func validInt(v any, min, max int64) bool {
	n := num(v)
	if max > 9007199254740991 {
		max = 9007199254740991
	}
	if n < min || n > max {
		return false
	}
	switch x := v.(type) {
	case json.Number:
		f, e := x.Float64()
		return e == nil && f == float64(n)
	case float64:
		return x == float64(n)
	case int, int64:
		return true
	}
	return false
}
func validText(v any, max int) bool {
	s, ok := v.(string)
	return ok && protocol.TextLength(s) > 0 && protocol.TextLength(s) <= max
}

func millis(v any) int64 {
	t, e := time.Parse(time.RFC3339Nano, text(v))
	if e != nil {
		return 0
	}
	return t.UnixMilli()
}
func isoValue(v any) any {
	if v == nil {
		return nil
	}
	t, e := time.Parse(time.RFC3339Nano, text(v))
	if e != nil {
		return v
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
