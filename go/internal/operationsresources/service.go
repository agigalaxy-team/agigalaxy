// Package operationsresources owns the original operator project/method
// directory and visibility layer. Current public sources stay in their domains.
package operationsresources

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"time"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type CapsuleReader interface {
	OperationsSourceWithin(context.Context, pgx.Tx, string) (map[string]any, error)
	OperationsMaintenanceWithin(context.Context, pgx.Tx, string) (map[string]any, error)
}
type Service struct {
	Pool              *pgxpool.Pool
	Endpoint          string
	Authority         operationspermissions.Authority
	Duty              operationspermissions.DutyAuthority
	PrincipalWithin   func(context.Context, pgx.Tx, Actor) error
	Projects          *projects.Service
	Capsules          CapsuleReader
	MaxHideSeconds    int64
	MaxHideSecondsNow func() int64
	Now               func() time.Time
}

func (s *Service) maxHideSeconds() int64 {
	if s.MaxHideSecondsNow != nil {
		return s.MaxHideSecondsNow()
	}
	return s.MaxHideSeconds
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) domain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Duty: s.Duty, PrincipalWithin: s.PrincipalWithin, Now: s.Now, Permissions: func(action string, x Object) []string {
		switch action {
		case "resources-query", "resource-read":
			return []string{"resources.read"}
		case "resource-visibility":
			if str(obj(x, "command"), "kind") == "restore" {
				return []string{"resources.restore"}
			}
			return []string{"resources.hide"}
		}
		return nil
	}}
}
func fail(code string, status int) error { return fault.New(code, status) }
func invalid() error                     { return fail("invalid_operations_request", 400) }
func str(x Object, k string) string      { s, _ := x[k].(string); return s }
func obj(x Object, k string) Object {
	switch v := x[k].(type) {
	case map[string]any:
		return v
	case *protocol.OrderedObject:
		return v.Values()
	}
	return nil
}
func number(v any) int64 {
	switch x := v.(type) {
	case int:
		return int64(x)
	case int64:
		return x
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	}
	return 0
}
func num(x Object, k string) int64 { return number(x[k]) }
func yes(x Object, k string) bool  { v, _ := x[k].(bool); return v }
func iso(v any) any {
	if v == nil {
		return nil
	}
	if t, ok := v.(time.Time); ok {
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	s, _ := v.(string)
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func one(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var b []byte
	e := tx.QueryRow(ctx, sql, args...).Scan(&b)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var out Object
	e = protocol.Decode(b, &out)
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
func resourceKind(kind string) (string, error) {
	switch kind {
	case "projects":
		return "project", nil
	case "methods":
		return "method", nil
	}
	return "", fail("not_found", 404)
}
func validID(s string) bool {
	u, e := uuid.Parse(s)
	return e == nil && strings.EqualFold(s, u.String()) && (u == uuid.Nil || strings.EqualFold(s, "ffffffff-ffff-ffff-ffff-ffffffffffff") || u.Variant() == uuid.RFC4122 && u.Version() >= 1 && u.Version() <= 8)
}
func (s *Service) row(ctx context.Context, tx pgx.Tx, kind, id string, lock bool) (Object, error) {
	if !validID(id) {
		return nil, invalid()
	}
	if _, e := resourceKind(kind); e != nil {
		return nil, e
	}
	table := "projects_v2"
	if kind == "methods" {
		table = "capsules"
	}
	clause := " FOR SHARE"
	if lock {
		clause = " FOR UPDATE"
	}
	r, e := one(ctx, tx, "SELECT to_jsonb(r) FROM "+table+" r WHERE id=$1"+clause, id)
	if e == nil && r == nil {
		e = fail("not_found", 404)
	}
	return r, e
}
func unavailable(e error) bool {
	for _, status := range []int{403, 404, 409, 410, 422} {
		if fault.Status(e) == status {
			return true
		}
	}
	return false
}
func (s *Service) source(ctx context.Context, tx pgx.Tx, kind string, r Object) (Object, error) {
	no := Object{"state": "unavailable", "title": nil, "content": nil, "readPermission": "current-public-source"}
	if kind == "projects" {
		if s.Projects == nil {
			return nil, fail("project_service_unavailable", 503)
		}
		v, e := s.Projects.OperationsSourceWithin(ctx, tx, str(r, "id"))
		if e != nil {
			if unavailable(e) {
				return no, nil
			}
			return nil, e
		}
		return Object{"state": "available", "title": obj(v, "document")["title"], "content": Object{"document": v["document"], "source": v["source"]}, "readPermission": "current-public-source"}, nil
	}
	if s.Capsules == nil {
		return nil, fail("capsule_service_unavailable", 503)
	}
	v, e := s.Capsules.OperationsSourceWithin(ctx, tx, str(r, "id"))
	if e != nil {
		if unavailable(e) {
			return no, nil
		}
		return nil, e
	}
	if str(v, "sourceStatus") == "source-unavailable" {
		return no, nil
	}
	p := obj(v, "payload")
	content := Object{"versionId": obj(v, "row")["id"], "deprecated": v["deprecated"], "securityIssue": v["securityIssue"], "sourceStatus": v["sourceStatus"]}
	for _, k := range []string{"version", "title", "problemPattern", "environment", "solutionStrategy", "tools", "skills", "mcpRefs", "verificationMethod", "limitations", "applicableScope", "license"} {
		content[k] = p[k]
	}
	return Object{"state": "available", "title": p["title"], "content": content, "readPermission": "current-public-source"}, nil
}
func (s *Service) view(ctx context.Context, tx pgx.Tx, a Actor, kind string, r Object, detail bool) (Object, error) {
	resource, e := resourceKind(kind)
	if e != nil {
		return nil, e
	}
	source, e := s.source(ctx, tx, kind, r)
	if e != nil {
		return nil, e
	}
	visibility, e := businessadmin.VisibilityWithin(ctx, tx, s.Endpoint, resource, str(r, "id"), s.now())
	if e != nil {
		return nil, e
	}
	var maintenance Object
	if kind == "methods" {
		if s.Capsules == nil {
			return nil, fail("capsule_service_unavailable", 503)
		}
		maintenance, e = s.Capsules.OperationsMaintenanceWithin(ctx, tx, str(r, "id"))
		if e != nil {
			return nil, e
		}
	}
	owner, creator := r["owner_id"], r["creator_id"]
	if owner == nil {
		owner = r["subject_id"]
	}
	if creator == nil {
		creator = r["subject_id"]
	}
	state := r["state"]
	if state == nil {
		state = "recorded"
		if yes(maintenance, "deprecated") {
			state = "deprecated"
		}
	}
	hide, restore := permitted(a, "resources.hide"), permitted(a, "resources.restore")
	out := Object{"id": r["id"], "kind": resource, "version": r["revision"], "ownerId": owner, "creatorId": creator, "state": state, "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]), "title": source["title"], "sourceState": source["state"], "visibility": visibility, "canManage": hide || restore, "canHide": hide && !yes(visibility, "hidden") && str(source, "state") == "available" && (r["state"] == nil || str(r, "state") == "active"), "canRestore": restore && yes(visibility, "hidden"), "maxHideSeconds": s.maxHideSeconds(), "checkedAt": s.now()}
	if kind == "methods" {
		out["deprecated"], out["securityIssue"] = maintenance["deprecated"], maintenance["securityIssue"]
	}
	if detail {
		out["publicContent"], out["readPermission"], out["privateMaterialsGranted"] = source["content"], source["readPermission"], false
	}
	return out, nil
}
func permitted(a Actor, code string) bool {
	for _, v := range a.Permissions {
		if v == code {
			return true
		}
	}
	return false
}
func (s *Service) List(ctx context.Context, a Actor, kind string, input Object) (Object, error) {
	q, e := parsePage(input)
	if e != nil {
		return nil, e
	}
	if _, e = resourceKind(kind); e != nil {
		return nil, e
	}
	if kind == "methods" {
		if _, ok := q["state"]; ok {
			return nil, invalid()
		}
	}
	selection := Object{"kind": kind}
	for k, v := range q {
		selection[k] = v
	}
	return s.domain().Run(ctx, a, "resources-query", selection, func(tx pgx.Tx, a Actor) (Object, error) {
		table := "projects_v2"
		if kind == "methods" {
			table = "capsules"
		}
		sql := "SELECT to_jsonb(r) FROM " + table + " r WHERE ($1::uuid IS NULL OR id>$1)"
		args := []any{q["after"], num(q, "limit") + 1}
		if kind == "projects" {
			sql += " AND ($3::text IS NULL OR state=$3)"
			args = append(args, q["state"])
		}
		sql += " ORDER BY id LIMIT $2"
		r, e := rows(ctx, tx, sql, args...)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var next any
		for i, v := range r {
			if int64(i) == num(q, "limit") {
				next = r[i-1]["id"]
				break
			}
			view, e := s.view(ctx, tx, a, kind, v, false)
			if e != nil {
				return nil, e
			}
			items = append(items, view)
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now()}, nil
	})
}
func (s *Service) Get(ctx context.Context, a Actor, kind, id string) (Object, error) {
	if _, e := resourceKind(kind); e != nil {
		return nil, e
	}
	return s.domain().Run(ctx, a, "resource-read", Object{"kind": kind, "id": id}, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.row(ctx, tx, kind, id, false)
		if e != nil {
			return nil, e
		}
		return s.view(ctx, tx, a, kind, r, true)
	})
}
func (s *Service) Visibility(ctx context.Context, a Actor, kind, id string, input Object) (Object, error) {
	x, e := parseVisibility(input)
	if e != nil {
		return nil, e
	}
	resource, e := resourceKind(kind)
	if e != nil {
		return nil, e
	}
	if !validID(id) {
		return nil, invalid()
	}
	return s.domain().Command(ctx, a, "resource-visibility", Object{"kind": kind, "id": id, "command": x, "operationId": x["operationId"]}, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.row(ctx, tx, kind, id, true)
		if e != nil {
			return nil, e
		}
		if str(x, "kind") == "hide" {
			if r["state"] != nil && str(r, "state") != "active" {
				return nil, fail("operations_source_unavailable", 409)
			}
			v, e := s.source(ctx, tx, kind, r)
			if e != nil {
				return nil, e
			}
			if str(v, "state") != "available" {
				return nil, fail("operations_source_unavailable", 409)
			}
		}
		return s.domain().ChangeVisibilityWithin(ctx, tx, resource, id, num(x, "expectedVersion"), num(r, "revision"), x, s.maxHideSeconds())
	})
}
