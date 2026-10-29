// Package operationsautonomy owns the existing durable duty/task lifecycle.
// Native/model state never substitutes for an original business receipt.
package operationsautonomy

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"sync"
	"time"
)

type Object = map[string]any
type Actor = perms.Actor
type Service struct {
	Pool                         *pgxpool.Pool
	Endpoint                     string
	Authority                    perms.Authority
	AIWork                       *operationsai.Service
	Now                          func() time.Time
	QualifyTargetWithin          func(context.Context, pgx.Tx, Actor, string, string, Object, Object, string) error
	CurrentPublicSourceWithin    func(context.Context, pgx.Tx, string, string) (Object, error)
	PersistedSourceWithin        func(context.Context, pgx.Tx, Object) (bool, error)
	RuntimeStatus                func(context.Context) (Object, error)
	NativeConfigured             func() bool
	CodeRunner                   func(context.Context, string) (Object, error)
	OriginalAIReceiptWithin      func(context.Context, pgx.Tx, Actor, businessadmin.OriginalAIReceiptSource) (Object, error)
	OriginalAIReceiptQueryWithin func(context.Context, pgx.Tx, Actor, perms.Authority, businessadmin.OriginalAIReceiptSource) (Object, error)
	ReadTargetWithin             func(context.Context, pgx.Tx, Actor, string, string, string) (Object, error)
	Native                       Native
	EnqueueWithin                func(context.Context, pgx.Tx, string, Object, string, *time.Time) error
	Permissions                  *perms.Service
	QueryTool                    func(context.Context, Actor, string, string, Object) (Object, error)
	ActionReady                  func(string) bool
	ExecuteDutyOperation         func(context.Context, Actor, string, Object, bool) (Object, error)
	SummaryForTask               func(context.Context, Actor, Object) (Object, error)
	WorkbenchRunDetail           func(context.Context, string) (Object, error)
	Log                          func(Object)
	defaultsMu                   sync.RWMutex
	defaults                     Object
}

func (s *Service) defaultNumber(key string) int64 {
	s.defaultsMu.RLock()
	v, ok := s.defaults[key]
	s.defaultsMu.RUnlock()
	if !ok {
		v = defaultSettings[key]
	}
	return num(v)
}
func (s *Service) refreshSettingsWithin(ctx context.Context, tx pgx.Tx) (Object, error) {
	settings, e := s.RuntimeSettingsWithin(ctx, tx)
	if e != nil {
		return nil, e
	}
	s.defaultsMu.Lock()
	if s.defaults == nil {
		s.defaults = Object{}
	}
	for k, v := range settings {
		s.defaults[k] = v
	}
	s.defaultsMu.Unlock()
	return settings, nil
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func fail(code string) error { return fault.New(code, 409) }
func str(v any) string       { s, _ := v.(string); return s }
func obj(v any) Object       { o, _ := v.(map[string]any); return o }
func list(v any) []any       { a, _ := v.([]any); return a }
func texts(v any) []string {
	if a, ok := v.([]string); ok {
		return append([]string{}, a...)
	}
	out := []string{}
	for _, v := range list(v) {
		out = append(out, str(v))
	}
	return out
}
func num(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	}
	return 0
}
func has(a []string, v string) bool {
	for _, s := range a {
		if s == v {
			return true
		}
	}
	return false
}

var domains = []string{"overview", "governance", "messaging", "discovery", "maintenance"}
var terminal = []string{"completed", "failed", "stopped", "blocked"}

func jsonText(v any) string { b, _ := protocol.EncodeJS(v); return string(b) }
func clone(v any) any       { b, _ := json.Marshal(v); var out any; json.Unmarshal(b, &out); return out }
func one(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var b []byte
	if e := tx.QueryRow(ctx, sql, args...).Scan(&b); e != nil {
		return nil, e
	}
	var o Object
	e := json.Unmarshal(b, &o)
	return o, e
}
func optional(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	o, e := one(ctx, tx, sql, args...)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return o, e
}
func many(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var b []byte
		if e := rows.Scan(&b); e != nil {
			return nil, e
		}
		var o Object
		if e := json.Unmarshal(b, &o); e != nil {
			return nil, e
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func (s *Service) taskWithin(ctx context.Context, tx pgx.Tx, id string, lock string) (Object, error) {
	r, e := optional(ctx, tx, `SELECT to_jsonb(t) FROM operations_autonomy_tasks_v1 t WHERE endpoint=$1 AND id=$2`+lock, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fault.New("operations_autonomy_task_not_found", 404)
	}
	return r, nil
}
func (s *Service) configWithin(ctx context.Context, tx pgx.Tx, domain, lock string) (Object, error) {
	if !has(domains, domain) {
		return nil, fault.New("invalid_operations_autonomy_request", 400)
	}
	r, e := optional(ctx, tx, `SELECT to_jsonb(c) FROM operations_autonomy_configs_v1 c WHERE endpoint=$1 AND domain=$2`+lock, s.Endpoint, domain)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fault.New("operations_autonomy_config_not_found", 404)
	}
	return r, nil
}
