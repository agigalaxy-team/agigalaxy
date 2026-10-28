// Package operationscommunity owns the existing operator forum consumers.
package operationscommunity

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"time"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type Service struct {
	Pool                *pgxpool.Pool
	Endpoint            string
	Authority           operationspermissions.Authority
	Duty                operationspermissions.DutyAuthority
	PrincipalWithin     func(context.Context, pgx.Tx, Actor) error
	ReadPrincipalWithin func(context.Context, pgx.Tx, Actor) (map[string]string, error)
	Forum               *community.Service
	Files               *community.AttachmentService
	Links               *accountlinks.Service
	Now                 func() time.Time
}

func fail(code string, status int) error { return fault.New(code, status) }
func str(x Object, k string) string      { v, _ := x[k].(string); return v }
func obj(x Object, k string) Object      { v, _ := x[k].(map[string]any); return v }
func num(x Object, k string) int64 {
	switch v := x[k].(type) {
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}
func yes(x Object, k string) bool { v, _ := x[k].(bool); return v }
func encode(v any) []byte         { b, _ := protocol.Encode(v); return b }
func iso(v any) any {
	if v == nil {
		return nil
	}
	if t, ok := v.(time.Time); ok {
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if s, ok := v.(string); ok {
		t, e := time.Parse(time.RFC3339Nano, s)
		if e == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	return nil
}
func seconds(v any) int64 {
	if t, ok := v.(time.Time); ok {
		return t.Unix()
	}
	s, _ := v.(string)
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t.Unix()
}
func stamp(n int64) time.Time { return time.Unix(n, 0).UTC() }
func jsDate(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t.UTC().Truncate(time.Millisecond)
	}
	t, _ := time.Parse(time.RFC3339Nano, str(Object{"v": v}, "v"))
	return t.UTC().Truncate(time.Millisecond)
}
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) policy() Object { return s.Forum.OperationsPolicy() }
func (s *Service) domain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Duty: s.Duty, PrincipalWithin: s.PrincipalWithin, Now: s.Now, Permissions: func(action string, x Object) []string {
		code := ""
		switch action {
		case "community-posts-query", "community-post-read":
			code = "content.read"
		case "community-sections-query", "community-section-read":
			code = "sections.read"
		case "community-section-classify":
			code = "sections.classify"
		case "community-section-visibility":
			code = "sections.hide"
			if str(x, "kind") == "restore" {
				code = "sections.restore"
			}
		case "community-reports-query", "community-report-read":
			code = "cases.read"
		case "community-report-resolve":
			code = "cases.resolve"
		case "operations-summary-read":
			code = "workbench.read"
		case "community-content-query", "community-content-read":
			code = "content.read"
		case "community-content-curation":
			code = "content.curate"
		case "community-tags-query":
			code = "content.tags.read"
		case "community-tag-create", "community-tag-update":
			code = "content.tags.manage"
		case "community-content-visibility":
			code = "content.hide"
			if str(x, "kind") == "restore" {
				code = "content.restore"
			}
		case "community-content-batch-visibility":
			code = "content.batch.hide"
			if str(x, "kind") == "restore" {
				code = "content.batch.restore"
			}
		case "community-content-batch-preview":
			code = "content.batch.hide"
			if str(x, "kind") == "restore" {
				code = "content.batch.restore"
			}
			return []string{"content.read", code}
		}
		if code == "" {
			return nil
		}
		return []string{code}
	}}
}
func permitted(a Actor, code string) bool {
	for _, v := range a.Permissions {
		if v == code {
			return true
		}
	}
	return false
}
func actorKind(s *Service, a Actor) string {
	if s.domain().IsExecution(a) {
		return "operations-executor"
	}
	if s.domain().IsDuty(a) {
		return "operations-ai-service"
	}
	return "business-operator"
}
func one(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, sql, args...).Scan(&raw)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var x Object
	e = protocol.Decode(raw, &x)
	return x, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		var b []byte
		if e = r.Scan(&b); e != nil {
			return nil, e
		}
		var x Object
		if e = protocol.Decode(b, &x); e != nil {
			return nil, e
		}
		out = append(out, x)
	}
	return out, r.Err()
}
func validID(s string) bool {
	u, e := uuid.Parse(s)
	return e == nil && strings.EqualFold(s, u.String()) && (u == uuid.Nil || strings.EqualFold(s, "ffffffff-ffff-ffff-ffff-ffffffffffff") || u.Variant() == uuid.RFC4122 && u.Version() >= 1 && u.Version() <= 8)
}
func digest(s string) string { return identity.Digest([]byte(s)) }
func (s *Service) ready() error {
	if s.Forum == nil {
		return fail("business_admin_unavailable", 503)
	}
	return nil
}
