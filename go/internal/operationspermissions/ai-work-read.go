package operationspermissions

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"sort"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func aiInvalid() error { return fail("invalid_operations_ai_work_request", 400) }
func (s *Service) aiAccountDomain(ctx context.Context, tx pgx.Tx, domain string, lock bool) (Object, error) {
	if !contains(operationsai.Domains, domain) {
		return nil, aiInvalid()
	}
	query := "SELECT to_jsonb(w) FROM operations_ai_work_accounts_v1 w WHERE endpoint=$1 AND domain=$2"
	if lock {
		query += " FOR UPDATE"
	}
	r, e := one(ctx, tx, query, s.Endpoint, domain)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fail("operations_ai_work_not_initialized", 409)
	}
	return r, e
}
func aiAccountView(r Object) Object {
	return Object{"id": r["id"], "domain": r["domain"], "name": r["name"], "description": r["description"], "enabled": r["enabled"], "version": r["version"], "authorizationVersion": r["authorization_version"], "createdAt": stamp(r["created_at"]), "updatedAt": stamp(r["updated_at"])}
}
func (s *Service) aiRead(ctx context.Context, actor Actor, operation func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	if s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		a, e := s.require(ctx, tx, actor, "ai.accounts.read")
		if e != nil {
			return nil, e
		}
		out, e := operation(tx, a)
		if e != nil {
			return nil, e
		}
		if _, e = s.require(ctx, tx, a, "ai.accounts.read"); e != nil {
			return nil, e
		}
		at := s.now()
		out["checkedAt"], out["readExpiresAt"], out["metadataOnly"] = at, at+30, true
		return out, nil
	})
}
func (s *Service) aiRoles(ctx context.Context, tx pgx.Tx, actor Actor) ([]any, error) {
	rows, e := many(ctx, tx, "SELECT jsonb_build_object('id',id,'name',name,'description',description,'enabled',enabled,'version',version,'permissions',permissions,'subject_scope',subject_scope) FROM operations_business_roles_v1 WHERE endpoint=$1 ORDER BY name,id", s.Endpoint)
	if e != nil {
		return nil, e
	}
	out := []any{}
	for _, v := range rows {
		r := obj(v)
		var reason any
		if r["enabled"] != true {
			reason = "role-disabled"
		} else if !contains(actor.Permissions, "ai.accounts.roles.write") {
			reason = "assignment-denied"
		} else {
			for _, p := range stringsOf(r["permissions"]) {
				if !known(p) || !contains(actor.Permissions, p) {
					reason = "exceeds-permissions"
					break
				}
			}
		}
		permissions := []string{}
		for _, p := range stringsOf(r["permissions"]) {
			if known(p) {
				permissions = append(permissions, p)
			}
		}
		r["subjectScope"] = r["subject_scope"]
		if r["subjectScope"] == nil {
			r["subjectScope"] = "shared"
		}
		delete(r, "subject_scope")
		r["permissions"], r["canAssign"], r["assignmentReason"] = arrayOf(permissions), reason == nil, reason
		out = append(out, r)
	}
	return out, nil
}
func (s *Service) aiAssignments(ctx context.Context, tx pgx.Tx, id string) ([]any, error) {
	rows, e := many(ctx, tx, `SELECT jsonb_build_object('id',a.id,'aiAccountId',a.ai_account_id,'roleId',a.role_id,'enabled',a.enabled,'version',a.version,'roleName',r.name,'roleEnabled',r.enabled,'roleVersion',r.version,'subjectScope',r.subject_scope,'permissions',r.permissions) FROM operations_ai_work_assignments_v1 a JOIN operations_business_roles_v1 r ON r.endpoint=a.endpoint AND r.id=a.role_id WHERE a.endpoint=$1 AND a.ai_account_id=$2 ORDER BY r.name,a.id`, s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	for _, v := range rows {
		r := obj(v)
		if r["subjectScope"] == nil {
			r["subjectScope"] = "shared"
		}
		permissions := []string{}
		for _, p := range stringsOf(r["permissions"]) {
			if known(p) {
				permissions = append(permissions, p)
			}
		}
		r["permissions"] = arrayOf(permissions)
	}
	return rows, nil
}
func aiEffective(account Object, assignments []any) Object {
	sources := []any{}
	permissions := []string{}
	seen := map[string]bool{}
	for _, v := range assignments {
		r := obj(v)
		if r["enabled"] != true || r["roleEnabled"] != true {
			continue
		}
		sources = append(sources, Object{"roleId": r["roleId"], "roleName": r["roleName"], "permissions": r["permissions"]})
		for _, p := range stringsOf(r["permissions"]) {
			if known(p) && !seen[p] {
				permissions = append(permissions, p)
				seen[p] = true
			}
		}
	}
	sort.Strings(permissions)
	state := "available"
	if account["enabled"] != true {
		state = "disabled"
	} else if len(sources) == 0 {
		state = "unassigned"
	}
	usable := []string{}
	if state == "available" {
		usable = permissions
	}
	out := Object{"state": state, "permissions": arrayOf(permissions), "sources": sources}
	for k, v := range operationsai.Capabilities(str(account["domain"]), usable) {
		out[k] = v
	}
	return out
}
func (s *Service) aiGrants(ctx context.Context, tx pgx.Tx, id string, actor Actor) (Object, error) {
	rows, e := many(ctx, tx, "SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 AND ai_account_id=$2 AND executor_kind='ai' ORDER BY created_at,id", s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range rows {
		r := obj(v)
		permissions := []string{}
		for _, p := range stringsOf(r["permissions"]) {
			if known(p) {
				permissions = append(permissions, p)
			}
		}
		items = append(items, Object{"id": r["id"], "name": r["name"], "enabled": r["enabled"], "version": r["version"], "mode": r["mode"], "permissions": arrayOf(permissions), "resourceScope": automationScope(r)})
	}
	return Object{"state": "available", "canConfigure": contains(actor.Permissions, "permissions.automation.write"), "items": items}, nil
}
func (s *Service) AIWorkList(ctx context.Context, actor Actor) (Object, error) {
	return s.aiRead(ctx, actor, func(tx pgx.Tx, a Actor) (Object, error) {
		rows, e := many(ctx, tx, "SELECT to_jsonb(w) FROM operations_ai_work_accounts_v1 w WHERE endpoint=$1 ORDER BY array_position($2::text[],domain)", s.Endpoint, operationsai.Domains)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, v := range rows {
			r := obj(v)
			assignments, e := s.aiAssignments(ctx, tx, str(r["id"]))
			if e != nil {
				return nil, e
			}
			effective := aiEffective(r, assignments)
			grants, e := s.aiGrants(ctx, tx, str(r["id"]), a)
			if e != nil {
				return nil, e
			}
			item := aiAccountView(r)
			names := []any{}
			for _, v := range arr(effective["sources"]) {
				names = append(names, obj(v)["roleName"])
			}
			item["roleNames"], item["permissionCount"], item["automationCount"] = names, len(arr(effective["permissions"])), len(arr(grants["items"]))
			items = append(items, item)
		}
		roles, e := s.aiRoles(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		state := "pending"
		if len(rows) == 5 {
			state = "ready"
		}
		return Object{"items": items, "roles": roles, "initialization": Object{"state": state, "recordedCount": len(rows), "expectedCount": 5}}, nil
	})
}
func (s *Service) AIWorkDetail(ctx context.Context, actor Actor, domain string) (Object, error) {
	if !contains(operationsai.Domains, domain) {
		return nil, aiInvalid()
	}
	return s.aiRead(ctx, actor, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.aiAccountDomain(ctx, tx, domain, false)
		if e != nil {
			return nil, e
		}
		assignments, e := s.aiAssignments(ctx, tx, str(r["id"]))
		if e != nil {
			return nil, e
		}
		roles, e := s.aiRoles(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		grants, e := s.aiGrants(ctx, tx, str(r["id"]), a)
		if e != nil {
			return nil, e
		}
		history, e := s.aiHistoryWithin(ctx, tx, domain, Object{})
		if e != nil {
			return nil, e
		}
		var href any
		if contains(a.Permissions, "management.accounts.read") {
			href = "/admin/operations/management-accounts?aiDomain=" + domain
		}
		return Object{"account": aiAccountView(r), "assignments": assignments, "roles": roles, "effective": aiEffective(r, assignments), "capabilities": Object{"canEditProfile": contains(a.Permissions, "ai.accounts.profile.write"), "canChangeState": contains(a.Permissions, "ai.accounts.state.write"), "canAssignRoles": contains(a.Permissions, "ai.accounts.roles.write")}, "automation": grants, "humanUse": Object{"permission": "ai.use." + domain, "source": "business-roles", "rootIncludesAll": true, "directoryHref": href}, "runtime": Object{"state": "pending", "modelState": "unknown"}, "history": history}, nil
	})
}
func storedAIAccount(v any) Object {
	r := obj(v)
	out := Object{}
	for _, k := range []string{"id", "domain", "name", "description", "enabled", "version", "authorizationVersion", "createdAt", "updatedAt"} {
		if v, ok := r[k]; ok {
			out[k] = v
		}
	}
	return out
}
func aiSelection(kind string, x Object) Object {
	switch kind {
	case "assignment-save":
		return Object{"id": x["id"], "expectedVersion": x["expectedVersion"], "roleId": x["roleId"], "enabled": x["enabled"]}
	case "state-save":
		return Object{"expectedVersion": x["expectedVersion"], "enabled": x["enabled"]}
	default:
		return Object{"expectedVersion": x["expectedVersion"], "name": x["name"], "description": x["description"]}
	}
}
func aiReceipt(r Object, replayed bool) (Object, error) {
	result := obj(r["result"])
	if result["account"] == nil {
		return nil, fail("operations_ai_work_receipt_unavailable", 503)
	}
	out := Object{"account": storedAIAccount(result["account"])}
	if r["kind"] == "assignment-save" && result["assignment"] != nil {
		assignment := obj(result["assignment"])
		a := Object{}
		for _, k := range []string{"id", "aiAccountId", "roleId", "enabled", "version", "roleName", "roleEnabled", "roleVersion"} {
			if v, ok := assignment[k]; ok {
				a[k] = v
			}
		}
		permissions := []string{}
		for _, p := range stringsOf(assignment["permissions"]) {
			if known(p) {
				permissions = append(permissions, p)
			}
		}
		a["permissions"] = arrayOf(permissions)
		out["assignment"] = a
	}
	return Object{"state": "recorded", "operationId": r["operation_id"], "kind": r["kind"], "domain": r["domain"], "selection": aiSelection(str(r["kind"]), obj(r["selection"])), "result": out, "recordedAt": stamp(r["created_at"]), "replayed": replayed}, nil
}
func (s *Service) AIWorkOperation(ctx context.Context, actor Actor, id string) (Object, error) {
	if !validUUID(id) {
		return nil, aiInvalid()
	}
	return s.aiRead(ctx, actor, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := one(ctx, tx, "SELECT to_jsonb(c) FROM operations_ai_work_commands_v1 c WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, id)
		if errors.Is(e, pgx.ErrNoRows) {
			return Object{"state": "not-recorded", "operationId": id, "kind": nil, "domain": nil, "selection": nil, "result": nil, "recordedAt": nil, "replayed": false}, nil
		}
		if e != nil {
			return nil, e
		}
		if r["operator_id"] != a.ID {
			return nil, fail("operations_ai_work_operation_not_found", 404)
		}
		return aiReceipt(r, true)
	})
}
func (s *Service) aiHistoryWithin(ctx context.Context, tx pgx.Tx, domain string, input Object) (Object, error) {
	x, e := parseAIHistory(input)
	if e != nil {
		return nil, aiInvalid()
	}
	if !exact(x, []string{"limit"}, []string{"after"}) {
		return nil, aiInvalid()
	}
	rows, e := many(ctx, tx, `SELECT to_jsonb(c)||jsonb_build_object('sequence',c.sequence::text,'operator_display_name',o.display_name) FROM operations_ai_work_commands_v1 c LEFT JOIN operations_operator_principals_v1 o ON o.endpoint=c.endpoint AND o.operator_id=c.operator_id WHERE c.endpoint=$1 AND c.domain=$2 AND ($3::bigint IS NULL OR c.sequence<$3) ORDER BY c.sequence DESC LIMIT $4`, s.Endpoint, domain, x["after"], num(x["limit"])+1)
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
		receipt, e := aiReceipt(r, false)
		if e != nil {
			return nil, e
		}
		var reason any
		if str(r["reason"]) != "" {
			reason = r["reason"]
		}
		var display any
		if name, ok := r["operator_display_name"].(string); ok && trim(name) != "" && protocol.TextLength(str(r["operator_id"])) <= 256 && !strings.HasPrefix(str(r["operator_id"]), "executor:") {
			display = trim(name)
		}
		receipt["sequence"], receipt["operatorId"], receipt["operatorDisplayName"], receipt["reason"] = r["sequence"], r["operator_id"], display, reason
		items = append(items, receipt)
	}
	return Object{"items": items, "nextAfter": next}, nil
}
func (s *Service) AIWorkHistory(ctx context.Context, actor Actor, domain string, input Object) (Object, error) {
	if !contains(operationsai.Domains, domain) {
		return nil, aiInvalid()
	}
	return s.aiRead(ctx, actor, func(tx pgx.Tx, _ Actor) (Object, error) {
		if _, e := s.aiAccountDomain(ctx, tx, domain, false); e != nil {
			return nil, e
		}
		return s.aiHistoryWithin(ctx, tx, domain, input)
	})
}
func (s *Service) AIWorkRuntime(ctx context.Context, actor Actor, domain string) (Object, error) {
	if !contains(operationsai.Domains, domain) {
		return nil, aiInvalid()
	}
	if _, e := s.aiRead(ctx, actor, func(tx pgx.Tx, _ Actor) (Object, error) { return s.aiAccountDomain(ctx, tx, domain, false) }); e != nil {
		return nil, e
	}
	runtime := Object{"state": "not-connected", "modelState": "unknown"}
	if s.RuntimeStatus != nil {
		value, e := s.RuntimeStatus(ctx)
		if e != nil {
			runtime = Object{"state": "unavailable", "modelState": "unknown"}
		} else {
			state := "unavailable"
			if value["state"] == "connected" {
				state = "connected"
			}
			model := "unknown"
			if value["modelState"] != "unknown" {
				if domains, ok := value["configuredDomains"].([]any); ok {
					model = "not-configured"
					for _, v := range domains {
						if v == domain {
							model = "configured"
						}
					}
				} else if value["modelState"] == "not-configured" {
					model = "not-configured"
				}
			}
			runtime = Object{"state": state, "modelState": model}
		}
	}
	return s.aiRead(ctx, actor, func(tx pgx.Tx, _ Actor) (Object, error) {
		if _, e := s.aiAccountDomain(ctx, tx, domain, false); e != nil {
			return nil, e
		}
		return Object{"domain": domain, "runtime": runtime}, nil
	})
}
