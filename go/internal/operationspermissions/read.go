package operationspermissions

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func catalogVersion(a Actor) string {
	p := fmt.Sprintf(`{"canManageRoles":%t,"canManageAssignments":%t,"canManageAutomation":%t}`, contains(a.Permissions, "permissions.roles.write"), contains(a.Permissions, "permissions.assignments.write"), contains(a.Permissions, "permissions.automation.write"))
	return identity.Digest([]byte(`{"items":` + catalogJSON + `,"permissions":` + p + `}`))
}
func (s *Service) Catalog(ctx context.Context, a Actor) (Object, error) {
	return s.read(ctx, a, func(_ pgx.Tx, a Actor) (Object, error) {
		return Object{"items": catalogItems(), "sourceVersion": catalogVersion(a)}, nil
	})
}
func (s *Service) CatalogLease(ctx context.Context, a Actor, version string) (Object, error) {
	return s.read(ctx, a, func(_ pgx.Tx, a Actor) (Object, error) {
		v := catalogVersion(a)
		return Object{"unchanged": version == v, "sourceVersion": v}, nil
	})
}
func (s *Service) roleUsage(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	var count int
	e := tx.QueryRow(ctx, "SELECT count(*)::integer FROM operations_role_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled", s.Endpoint, id).Scan(&count)
	if e != nil {
		return nil, e
	}
	accounts, e := many(ctx, tx, `SELECT jsonb_build_object('id',w.id,'domain',w.domain,'name',w.name,'enabled',w.enabled) FROM operations_ai_work_assignments_v1 a JOIN operations_ai_work_accounts_v1 w ON w.endpoint=a.endpoint AND w.id=a.ai_account_id WHERE a.endpoint=$1 AND a.role_id=$2 AND a.enabled ORDER BY w.domain,w.id`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	return Object{"usage": Object{"humanAssignments": count, "aiAssignments": len(accounts), "aiAccounts": accounts}, "impact": Object{"affectsPeople": count > 0, "affectsAi": len(accounts) > 0, "assignmentCount": count + len(accounts)}}, nil
}
func (s *Service) Roles(ctx context.Context, a Actor) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		rows, e := many(ctx, tx, "SELECT to_jsonb(r) FROM operations_business_roles_v1 r WHERE endpoint=$1 ORDER BY created_at,id", s.Endpoint)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, v := range rows {
			r := obj(v)
			out := roleView(r)
			usage, e := s.roleUsage(ctx, tx, str(r["id"]))
			if e != nil {
				return nil, e
			}
			for k, v := range usage {
				out[k] = v
			}
			items = append(items, out)
		}
		return Object{"items": items, "nextAfter": nil}, nil
	})
}
func (s *Service) Role(ctx context.Context, a Actor, id string) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		r, e := one(ctx, tx, "SELECT to_jsonb(r) FROM operations_business_roles_v1 r WHERE endpoint=$1 AND id=$2", s.Endpoint, id)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fail("operations_role_not_found", 404)
		}
		if e != nil {
			return nil, e
		}
		out := roleView(r)
		usage, e := s.roleUsage(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		for k, v := range usage {
			out[k] = v
		}
		return Object{"role": out}, nil
	})
}
func (s *Service) Personnel(ctx context.Context, a Actor) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		people, e := many(ctx, tx, "SELECT jsonb_build_object('operator_id',operator_id,'display_name',display_name) FROM operations_operator_principals_v1 WHERE endpoint=$1 ORDER BY operator_id", s.Endpoint)
		if e != nil {
			return nil, e
		}
		assignments, e := many(ctx, tx, "SELECT to_jsonb(a) FROM operations_role_assignments_v1 a WHERE endpoint=$1 ORDER BY created_at,id", s.Endpoint)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, v := range people {
			p := obj(v)
			id := str(p["operator_id"])
			var effective any
			state, eligibility := "unknown", "unknown"
			current, e := s.Authority.PersonWithin(ctx, tx, id, true)
			if e == nil {
				effective = Object{"version": current.Version, "permissions": arrayOf(current.Permissions), "source": "business-roles"}
				if current.Role == "administrator" {
					obj(effective)["source"] = "preconfigured-root"
				}
				state = "available"
				if current.ManagementEligibility != "" {
					eligibility = current.ManagementEligibility
				}
			} else if fault.Status(e) == 403 {
				state = "not-eligible"
			}
			assigned := []any{}
			for _, v := range assignments {
				r := obj(v)
				if r["operator_id"] == id {
					assigned = append(assigned, assignmentView(r))
				}
			}
			items = append(items, Object{"operatorId": id, "displayName": p["display_name"], "identityState": "known-management-principal", "assignments": assigned, "authorizationState": state, "effective": effective, "managementEligibility": eligibility})
		}
		return Object{"items": items, "nextAfter": nil}, nil
	})
}

var changedFieldNames = []string{"name", "description", "enabled", "permissions", "operatorId", "roleId", "executorKind", "mode", "resourceIds", "resourceScope", "aiAccountId", "subjectScope"}

func enabledDelta(v any) (Object, bool) {
	o := obj(v)
	if o == nil {
		return nil, false
	}
	if o["before"] != nil {
		if _, ok := o["before"].(bool); !ok {
			return nil, false
		}
	}
	after, ok := o["after"].(bool)
	if !ok {
		return nil, false
	}
	if _, ok := o["before"]; !ok {
		return nil, false
	}
	return Object{"before": o["before"], "after": after}, true
}
func permissionDelta(v any) (Object, bool) {
	o := obj(v)
	if o == nil || !permissionList(o["added"]) || !permissionList(o["removed"]) {
		return nil, false
	}
	return Object{"added": o["added"], "removed": o["removed"]}, true
}
func resourceScope(v any) (Object, bool) {
	if a, ok := v.([]any); ok {
		if len(a) == 0 {
			return Object{"kind": "unresolved"}, true
		}
		v = Object{"kind": "selected", "resourceIds": a}
	}
	o := obj(v)
	if o == nil {
		return nil, false
	}
	switch o["kind"] {
	case "unresolved", "eligible":
		if !exact(o, []string{"kind"}, nil) {
			return nil, false
		}
		return Object{"kind": o["kind"]}, true
	case "selected":
		if !exact(o, []string{"kind", "resourceIds"}, nil) {
			return nil, false
		}
		a, ok := o["resourceIds"].([]any)
		if !ok || len(a) < 1 || len(a) > 100 {
			return nil, false
		}
		seen := map[string]bool{}
		for _, id := range a {
			if !validUUID(id) || seen[str(id)] {
				return nil, false
			}
			seen[str(id)] = true
		}
		return Object{"kind": "selected", "resourceIds": a}, true
	}
	return nil, false
}
func safeDelta(row Object) any {
	d := obj(row["delta"])
	if d == nil || str(d["kind"])+"-save" != row["kind"] {
		return nil
	}
	enabled, ok := enabledDelta(d["enabled"])
	if !ok {
		return nil
	}
	out := Object{"kind": d["kind"], "enabled": enabled}
	switch d["kind"] {
	case "role", "automation":
		p, ok := permissionDelta(d["permissions"])
		if !ok {
			return nil
		}
		out["permissions"] = p
	case "assignment":
		if utf8.RuneCountInString(str(d["operatorId"])) < 1 || utf8.RuneCountInString(str(d["operatorId"])) > 1024 || !validUUID(d["roleId"]) || d["operatorId"] != row["assignment_operator_id"] || d["roleId"] != row["assignment_role_id"] {
			return nil
		}
		out["operatorId"], out["roleId"] = d["operatorId"], d["roleId"]
	default:
		return nil
	}
	if d["kind"] == "automation" {
		scope := obj(d["scope"])
		if scope == nil {
			return nil
		}
		var before any
		if scope["before"] != nil {
			b, ok := resourceScope(scope["before"])
			if !ok {
				return nil
			}
			before = b
		} else if _, ok := scope["before"]; !ok {
			return nil
		}
		after, ok := resourceScope(scope["after"])
		if !ok {
			return nil
		}
		out["scope"] = Object{"before": before, "after": after}
		for _, item := range []struct {
			key    string
			values []string
		}{{"mode", []string{"assisted", "automatic"}}, {"executorKind", []string{"program", "ai"}}} {
			o := obj(d[item.key])
			if o == nil {
				return nil
			}
			if _, ok := o["before"]; !ok {
				return nil
			}
			if o["before"] != nil && !contains(item.values, str(o["before"])) || !contains(item.values, str(o["after"])) {
				return nil
			}
			out[item.key] = Object{"before": o["before"], "after": o["after"]}
		}
		if v, ok := d["aiAccountId"]; ok {
			o := obj(v)
			if o == nil {
				return nil
			}
			for _, k := range []string{"before", "after"} {
				v, ok := o[k]
				if !ok || v != nil && !validUUID(v) {
					return nil
				}
			}
			out["aiAccountId"] = Object{"before": o["before"], "after": o["after"]}
		}
	}
	return out
}
func (s *Service) History(ctx context.Context, a Actor, input Object) (Object, error) {
	x, e := parseHistory(input)
	if e != nil {
		return nil, e
	}
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		if id := x["targetOperatorId"]; id != nil {
			ok, e := exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2)", s.Endpoint, id)
			if e != nil {
				return nil, e
			}
			if !ok {
				return nil, fail("operations_person_not_found", 404)
			}
		}
		join := "LEFT JOIN"
		filter := ""
		args := []any{s.Endpoint, x["after"], x["resourceId"], num(x["limit"]) + 1}
		if x["targetOperatorId"] != nil {
			join = "JOIN"
			filter = " AND a.operator_id=$5"
			args = append(args, x["targetOperatorId"])
		}
		rows, e := many(ctx, tx, `SELECT to_jsonb(e)||jsonb_build_object('sequence',e.sequence::text,'delta',e.result->'delta','operator_display_name',NULLIF(BTRIM(o.display_name),''),'assignment_operator_id',a.operator_id,'assignment_role_id',a.role_id,'assignment_operator_display_name',NULLIF(BTRIM(person.display_name),'')) FROM operations_permission_events_v1 e `+join+` operations_role_assignments_v1 a ON e.kind='assignment-save' AND a.id=e.resource_id AND a.endpoint=e.endpoint LEFT JOIN operations_operator_principals_v1 o ON o.operator_id=e.operator_id AND o.endpoint=e.endpoint LEFT JOIN operations_operator_principals_v1 person ON person.operator_id=a.operator_id AND person.endpoint=e.endpoint WHERE e.endpoint=$1 AND ($2::bigint IS NULL OR e.sequence<$2) AND ($3::uuid IS NULL OR e.resource_id=$3)`+filter+` ORDER BY e.sequence DESC LIMIT $4`, args...)
		if e != nil {
			return nil, e
		}
		limit := int(num(x["limit"]))
		var next any
		if len(rows) > limit {
			next = obj(rows[limit-1])["sequence"]
			rows = rows[:limit]
		}
		items := []any{}
		for _, v := range rows {
			r := obj(v)
			delta := safeDelta(r)
			fields := []any{}
			for _, f := range arr(r["changed_fields"]) {
				if contains(changedFieldNames, str(f)) {
					fields = append(fields, f)
				}
			}
			var display any
			if obj(delta)["kind"] == "assignment" {
				display = r["assignment_operator_display_name"]
			}
			items = append(items, Object{"id": r["id"], "sequence": r["sequence"], "kind": r["kind"], "operatorId": r["operator_id"], "operatorDisplayName": r["operator_display_name"], "resourceId": r["resource_id"], "version": r["version"], "changedFields": fields, "delta": delta, "assignmentOperatorDisplayName": display, "createdAt": stamp(r["created_at"])})
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
