package operationspermissions

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func idsOK(v any, max int, nonempty bool) bool {
	a, ok := v.([]any)
	if !ok || len(a) > max || nonempty && len(a) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range a {
		if !validUUID(v) || seen[str(v)] {
			return false
		}
		seen[str(v)] = true
	}
	return true
}
func parseAutomation(input Object) (Object, error) {
	x := obj(clone(input))
	if !exact(x, []string{"operationId", "expectedVersion", "name", "executorKind", "mode", "enabled", "permissions", "resourceIds"}, []string{"id", "resourceScope", "aiAccountId"}) || !validUUID(x["operationId"]) || !intOK(x["expectedVersion"], 0) || !permissionList(x["permissions"]) || !idsOK(x["resourceIds"], 100, false) {
		return nil, invalid()
	}
	if v, ok := x["id"]; ok && !validUUID(v) {
		return nil, invalid()
	}
	if _, ok := x["enabled"].(bool); !ok {
		return nil, invalid()
	}
	if x["executorKind"] != "program" && x["executorKind"] != "ai" || x["mode"] != "assisted" && x["mode"] != "automatic" {
		return nil, invalid()
	}
	name, ok := text(x["name"], 1, 120, true)
	if !ok {
		return nil, invalid()
	}
	x["name"] = name
	if v, ok := x["resourceScope"]; ok {
		scope, ok := resourceScope(v)
		if !ok {
			return nil, invalid()
		}
		x["resourceScope"] = scope
	}
	if v, ok := x["aiAccountId"]; ok && v != nil && !validUUID(v) {
		return nil, invalid()
	}
	return x, nil
}
func automationScope(row Object) Object {
	ids := row["resource_ids"]
	if ids == nil {
		ids = row["resourceIds"]
	}
	if ids == nil {
		ids = []any{}
	}
	if !idsOK(ids, 100, false) {
		return Object{"kind": "unresolved"}
	}
	kind := row["resource_scope_kind"]
	if kind == "eligible" && len(arr(ids)) == 0 {
		return Object{"kind": "eligible"}
	}
	if (kind == nil || kind == "selected") && len(arr(ids)) > 0 {
		return Object{"kind": "selected", "resourceIds": ids}
	}
	return Object{"kind": "unresolved"}
}
func scopeForSave(x, old Object) (Object, error) {
	var before Object
	if old != nil {
		before = automationScope(old)
	}
	var scope Object
	if value, present := x["resourceScope"]; present {
		scope = obj(value)
		if scope["kind"] == "selected" && !sameSet(scope["resourceIds"], x["resourceIds"]) || scope["kind"] != "selected" && len(arr(x["resourceIds"])) != 0 {
			return nil, fail("operations_automation_scope_invalid", 400)
		}
		if scope["kind"] == "unresolved" && before["kind"] != "unresolved" {
			return nil, fail("operations_automation_scope_required", 400)
		}
	} else if old != nil {
		previous := before["resourceIds"]
		if previous == nil {
			previous = []any{}
		}
		if !sameSet(x["resourceIds"], previous) {
			return nil, fail("operations_automation_scope_required", 400)
		}
		scope = before
	} else {
		if len(arr(x["resourceIds"])) == 0 {
			return nil, fail("operations_automation_scope_required", 400)
		}
		scope = Object{"kind": "selected", "resourceIds": x["resourceIds"]}
	}
	var kind any = scope["kind"]
	if kind == "unresolved" {
		kind = nil
	}
	ids := scope["resourceIds"]
	if ids == nil {
		ids = []any{}
	}
	return Object{"resource_scope_kind": kind, "resource_ids": ids}, nil
}
func scopeCapability(row Object) Object {
	scope := automationScope(row)
	supported := []string{}
	for _, p := range stringsOf(row["permissions"]) {
		if operationsai.Autonomous(p) {
			supported = append(supported, p)
		}
	}
	var reason any
	if scope["kind"] == "unresolved" {
		reason = "operations_automation_scope_unresolved"
	} else if len(supported) == 0 {
		reason = "operations_agentos_action_unavailable"
	}
	return Object{"state": scope["kind"], "canBindObjects": reason == nil, "reason": reason, "supportedActions": arrayOf(supported)}
}
func (s *Service) automationBinding(ctx context.Context, tx pgx.Tx, row Object) (Object, error) {
	if row["executor_kind"] != "ai" {
		return Object{"aiAccountId": nil, "bindingState": "not-applicable", "aiAccount": nil}, nil
	}
	id := row["ai_account_id"]
	if id == nil {
		return Object{"aiAccountId": nil, "bindingState": "unassigned", "aiAccount": nil}, nil
	}
	account, e := one(ctx, tx, "SELECT jsonb_build_object('id',id,'domain',domain,'name',name,'enabled',enabled) FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND id=$2", s.Endpoint, id)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	out := Object{"aiAccountId": id, "bindingState": "unavailable", "aiAccount": account}
	if account == nil || s.AIWork == nil {
		return out, nil
	}
	current, e := s.AIWork.AuthorizationWithin(ctx, tx, str(account["domain"]), pointer(str(id)))
	if e != nil {
		return nil, e
	}
	state := "bound"
	if !current.Enabled {
		state = "disabled"
	} else {
		p := stringsOf(row["permissions"])
		if len(p) == 0 {
			state = "unsupported"
		}
		for _, code := range p {
			if !operationsai.Autonomous(code) {
				state = "unsupported"
				break
			}
		}
		if state == "bound" {
			for _, code := range p {
				if !contains(current.Permissions, code) {
					state = "role-exceeded"
					break
				}
			}
		}
	}
	allowed := []string{}
	if current.Enabled {
		allowed = current.Permissions
	}
	actions := []any{}
	for _, p := range stringsOf(row["permissions"]) {
		ready := false
		if s.AIWork.HandlerReady != nil {
			ready = s.AIWork.HandlerReady(p)
		}
		actions = append(actions, operationsai.Projection(p, allowed, &ready, nil))
	}
	out["bindingState"], out["actionReadiness"] = state, actions
	return out, nil
}
func pointer(s string) *string { return &s }
func automationView(row, runtime, binding Object) Object {
	ai := row["executor_kind"] == "ai"
	actual := binding
	if actual == nil {
		state := "not-applicable"
		if ai {
			state = "unassigned"
			if row["ai_account_id"] != nil {
				state = "unavailable"
			}
		}
		actual = Object{"aiAccountId": row["ai_account_id"], "bindingState": state, "aiAccount": nil}
	}
	cap := scopeCapability(row)
	usable := cap["canBindObjects"] == true && (!ai || actual["bindingState"] == "bound")
	modelReady := !ai || runtime["modelState"] == "configured"
	if ai && modelReady {
		if domains, ok := runtime["configuredDomains"].([]any); ok {
			modelReady = false
			for _, d := range domains {
				if d == obj(actual["aiAccount"])["domain"] {
					modelReady = true
				}
			}
		}
	}
	reasons := []string{}
	if cap["canBindObjects"] != true {
		reasons = append(reasons, "object-scope-unresolved")
	}
	if ai && actual["bindingState"] != "bound" {
		reasons = append(reasons, str(actual["bindingState"]))
	}
	actions := arr(actual["actionReadiness"])
	if actions == nil {
		actions = []any{}
	}
	handlerReady := runtime["state"] == "connected"
	if ai {
		handlerReady = len(actions) > 0
		for _, v := range actions {
			if obj(v)["handlerReady"] != true {
				handlerReady = false
			}
		}
	}
	ready := handlerReady && runtime["state"] == "connected" && modelReady
	readinessReasons := []string{}
	if !handlerReady {
		readinessReasons = append(readinessReasons, "handler-not-connected")
	}
	if runtime["state"] != "connected" {
		readinessReasons = append(readinessReasons, "runtime-not-connected")
	}
	if !modelReady {
		readinessReasons = append(readinessReasons, "model-not-configured")
	}
	state := "not-connected"
	if usable && handlerReady && runtime != nil && runtime["state"] != "not-configured" {
		switch {
		case runtime["state"] != "connected":
			state = "unavailable"
		case !modelReady:
			state = "model-not-configured"
		case row["mode"] == "automatic":
			state = "awaiting-trigger"
		default:
			state = "connected"
		}
	}
	out := Object{"id": row["id"], "name": row["name"], "executorKind": row["executor_kind"], "mode": row["mode"], "enabled": row["enabled"], "version": row["version"], "permissions": row["permissions"], "resourceIds": row["resource_ids"], "authorization": Object{"saved": true, "effective": len(reasons) == 0, "reasons": arrayOf(reasons)}, "readiness": Object{"ready": ready, "reasons": arrayOf(readinessReasons), "actions": actions}, "resourceScope": automationScope(row), "scopeCapability": cap, "executionState": state, "executionAvailable": row["enabled"] == true && ready && usable && runtime["state"] == "connected" && row["mode"] == "assisted" && modelReady, "createdAt": stamp(row["created_at"]), "updatedAt": stamp(row["updated_at"])}
	for k, v := range actual {
		out[k] = v
	}
	return out
}
func (s *Service) automationOptions(ctx context.Context, tx pgx.Tx, actor Actor) (Object, error) {
	items := []any{}
	if s.AIWork == nil {
		return Object{"state": "unavailable", "items": items}, nil
	}
	rows, e := many(ctx, tx, "SELECT jsonb_build_object('id',id,'domain',domain,'name',name,'enabled',enabled) FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 ORDER BY domain,id", s.Endpoint)
	if e != nil {
		return nil, e
	}
	for _, v := range rows {
		row := obj(v)
		current, e := s.AIWork.AuthorizationWithin(ctx, tx, str(row["domain"]), pointer(str(row["id"])))
		if e != nil {
			return nil, e
		}
		rolePermissions := stringsOf(operationsai.Capabilities(str(row["domain"]), current.Permissions)["autonomousPermissions"])
		executable, permissions := []string{}, []string{}
		for _, p := range rolePermissions {
			if contains(actor.Permissions, p) {
				executable = append(executable, p)
			}
		}
		for _, p := range current.Permissions {
			if contains(actor.Permissions, p) {
				permissions = append(permissions, p)
			}
		}
		var reason any
		switch {
		case !current.Enabled:
			reason = "account-disabled"
		case len(rolePermissions) == 0:
			reason = "role-missing"
		case !contains(actor.Permissions, "permissions.automation.write"):
			reason = "assignment-denied"
		case len(executable) == 0:
			reason = "exceeds-permissions"
		}
		readiness := []any{}
		for _, p := range rolePermissions {
			ready := false
			if s.AIWork.HandlerReady != nil {
				ready = s.AIWork.HandlerReady(p)
			}
			readiness = append(readiness, operationsai.Projection(p, permissions, &ready, nil))
		}
		item := obj(clone(row))
		item["permissions"], item["rolePermissions"], item["executablePermissions"], item["readiness"] = arrayOf(permissions), arrayOf(rolePermissions), arrayOf(executable), readiness
		item["canSave"] = contains(actor.Permissions, "permissions.automation.write")
		item["canEnable"] = current.Enabled && len(executable) > 0 && item["canSave"] == true
		item["unavailableReason"] = reason
		items = append(items, item)
	}
	return Object{"state": "available", "items": items}, nil
}
func (s *Service) Automation(ctx context.Context, a Actor) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, actor Actor) (Object, error) {
		var runtime Object
		if s.RuntimeStatus != nil {
			r, e := s.RuntimeStatus(ctx)
			runtime = r
			if e != nil {
				runtime = Object{"state": "unavailable", "modelState": "unknown"}
			}
		}
		rows, e := many(ctx, tx, "SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 ORDER BY created_at,id", s.Endpoint)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, v := range rows {
			r := obj(v)
			binding, e := s.automationBinding(ctx, tx, r)
			if e != nil {
				return nil, e
			}
			items = append(items, automationView(r, runtime, binding))
		}
		options, e := s.automationOptions(ctx, tx, actor)
		if e != nil {
			return nil, e
		}
		state, model := "not-connected", "not-configured"
		if runtime["state"] != nil {
			state = str(runtime["state"])
		}
		if runtime["modelState"] != nil {
			model = str(runtime["modelState"])
		}
		return Object{"items": items, "aiAccountOptions": options, "nextAfter": nil, "execution": Object{"state": state, "available": runtime["state"] == "connected", "modelState": model, "automaticTriggers": "not-connected"}}, nil
	})
}
func (s *Service) SaveAutomation(ctx context.Context, a Actor, input Object) (Object, error) {
	x, e := parseAutomation(input)
	if e != nil {
		return nil, e
	}
	return s.command(ctx, a, "permissions.automation.write", "automation-save", x, func(tx pgx.Tx, actor Actor) (mutation, error) {
		if e := subset(actor, stringsOf(x["permissions"])); e != nil {
			return mutation{}, e
		}
		for _, p := range arr(x["permissions"]) {
			for _, v := range catalogItems() {
				item := obj(v)
				if item["code"] == p && item["humanOnly"] == true {
					return mutation{}, fail("operations_automation_human_boundary", 403)
				}
			}
		}
		var old Object
		if x["id"] != nil {
			old, e = one(ctx, tx, "SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 AND id=$2 FOR UPDATE", s.Endpoint, x["id"])
			old, e = optionalRow(old, e)
			if e != nil {
				return mutation{}, e
			}
			if old == nil {
				return mutation{}, fail("operations_automation_not_found", 404)
			}
		}
		if num(old["version"]) != num(x["expectedVersion"]) {
			return mutation{}, fail("operations_permissions_version_changed", 409)
		}
		aiID, provided := x["aiAccountId"]
		if !provided {
			aiID = old["ai_account_id"]
		}
		if x["executorKind"] == "program" {
			if aiID != nil {
				return mutation{}, fail("operations_automation_ai_binding_invalid", 400)
			}
		} else if aiID == nil {
			if x["enabled"] == true {
				return mutation{}, fail("operations_automation_ai_binding_required", 400)
			}
		} else {
			found, e := exists(ctx, tx, "SELECT EXISTS(SELECT 1 FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND id=$2)", s.Endpoint, aiID)
			if e != nil {
				return mutation{}, e
			}
			if !found {
				return mutation{}, fail("operations_automation_ai_account_not_found", 404)
			}
		}
		scope, e := scopeForSave(x, old)
		if e != nil {
			return mutation{}, e
		}
		id := str(old["id"])
		if id == "" {
			id = uuid.NewString()
		}
		version := num(old["version"]) + 1
		row, e := one(ctx, tx, `INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,resource_scope_kind,created_by,updated_by,created_at,updated_at,ai_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$12,$13) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,executor_kind=EXCLUDED.executor_kind,mode=EXCLUDED.mode,enabled=EXCLUDED.enabled,version=EXCLUDED.version,permissions=EXCLUDED.permissions,resource_ids=EXCLUDED.resource_ids,resource_scope_kind=EXCLUDED.resource_scope_kind,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at,ai_account_id=EXCLUDED.ai_account_id RETURNING to_jsonb(operations_automation_grants_v1)`, id, s.Endpoint, x["name"], x["executorKind"], x["mode"], x["enabled"], version, stringsOf(x["permissions"]), stringsOf(scope["resource_ids"]), scope["resource_scope_kind"], actor.ID, time.Unix(s.now(), 0), aiID)
		if e != nil {
			return mutation{}, e
		}
		fields := []string{}
		for _, k := range []string{"name", "executorKind", "mode", "enabled", "permissions"} {
			column := k
			if k == "executorKind" {
				column = "executor_kind"
			}
			changed := !same(old[column], x[k])
			if k == "permissions" {
				changed = !sameSet(old["permissions"], x["permissions"])
			}
			if old == nil || changed {
				fields = append(fields, k)
			}
		}
		var before any
		if old != nil {
			before = automationScope(old)
		}
		scopeDelta := Object{"before": before, "after": automationScope(row)}
		if old == nil || !same(before, scopeDelta["after"]) {
			fields = append(fields, "resourceScope")
		}
		if old["ai_account_id"] != aiID {
			fields = append(fields, "aiAccountId")
		}
		binding, e := s.automationBinding(ctx, tx, row)
		if e != nil {
			return mutation{}, e
		}
		count := len(arr(x["permissions"]))
		return mutation{Object{"automation": automationView(row, nil, binding)}, id, version, fields, x["enabled"].(bool), &count, Object{"kind": "automation", "permissions": codesChanged(old["permissions"], x["permissions"]), "enabled": Object{"before": old["enabled"], "after": x["enabled"]}, "scope": scopeDelta, "mode": Object{"before": old["mode"], "after": x["mode"]}, "executorKind": Object{"before": old["executor_kind"], "after": x["executorKind"]}, "aiAccountId": Object{"before": old["ai_account_id"], "after": aiID}}}, nil
	})
}
func automationReceipt(row Object) (Object, error) {
	unavailable := func() (Object, error) { return nil, fail("operations_permissions_receipt_unavailable", 503) }
	x, e := parseAutomation(obj(row["input"]))
	if e != nil {
		return unavailable()
	}
	selection := Object{"id": x["id"], "expectedVersion": x["expectedVersion"]}
	for _, k := range []string{"name", "executorKind", "mode", "enabled", "permissions", "resourceIds"} {
		selection[k] = x[k]
	}
	for _, k := range []string{"resourceScope", "aiAccountId"} {
		if v, ok := x[k]; ok {
			selection[k] = v
		}
	}
	saved := obj(obj(row["result"])["automation"])
	if saved == nil {
		return unavailable()
	}
	out := Object{}
	for _, k := range []string{"id", "name", "enabled", "version", "permissions", "createdAt", "updatedAt", "executorKind", "mode", "resourceIds", "executionState", "executionAvailable"} {
		v, ok := saved[k]
		if !ok {
			return unavailable()
		}
		switch k {
		case "enabled", "executionAvailable":
			if _, ok := v.(bool); !ok {
				return unavailable()
			}
		case "version":
			if !intOK(v, 0) {
				return unavailable()
			}
		case "permissions", "resourceIds":
			a, ok := v.([]any)
			if !ok {
				return unavailable()
			}
			for _, v := range a {
				if _, ok := v.(string); !ok {
					return unavailable()
				}
			}
		default:
			if _, ok := v.(string); !ok {
				return unavailable()
			}
		}
		out[k] = v
	}
	if !contains([]string{"program", "ai"}, str(out["executorKind"])) || !contains([]string{"assisted", "automatic"}, str(out["mode"])) || !contains([]string{"not-connected", "model-not-configured", "awaiting-trigger", "connected", "unavailable"}, str(out["executionState"])) {
		return unavailable()
	}
	scope := obj(saved["resourceScope"])
	switch scope["kind"] {
	case "selected":
		a, ok := scope["resourceIds"].([]any)
		if !ok {
			return unavailable()
		}
		for _, v := range a {
			if _, ok := v.(string); !ok {
				return unavailable()
			}
		}
		out["resourceScope"] = Object{"kind": "selected", "resourceIds": a}
	case "eligible":
		out["resourceScope"] = Object{"kind": "eligible"}
	default:
		if scope["kind"] == "unresolved" || len(arr(saved["resourceIds"])) == 0 {
			out["resourceScope"] = Object{"kind": "unresolved"}
		} else {
			out["resourceScope"] = Object{"kind": "selected", "resourceIds": saved["resourceIds"]}
		}
	}
	id := saved["aiAccountId"]
	state := saved["bindingState"]
	if state == nil {
		state = "not-applicable"
		if out["executorKind"] == "ai" {
			state = "unassigned"
		}
	}
	if id != nil && !receiptUUID.MatchString(str(id)) || !contains([]string{"not-applicable", "unassigned", "bound", "disabled", "role-exceeded", "unsupported", "unavailable"}, str(state)) || out["executorKind"] == "program" && id != nil {
		return unavailable()
	}
	var account any
	if saved["aiAccount"] != nil {
		v := obj(saved["aiAccount"])
		name := str(v["name"])
		if v == nil || v["id"] != id || !contains(operationsai.Domains, str(v["domain"])) || trim(name) == "" || protocol.TextLength(name) > 100 {
			return unavailable()
		}
		for _, c := range name {
			if unicode.Is(unicode.Cc, c) {
				return unavailable()
			}
		}
		if _, ok := v["enabled"].(bool); !ok {
			return unavailable()
		}
		account = Object{"id": v["id"], "domain": v["domain"], "name": v["name"], "enabled": v["enabled"]}
	}
	if out["executorKind"] == "program" && (state != "not-applicable" || account != nil) || out["executorKind"] == "ai" && (id == nil && (state != "unassigned" || account != nil) || id != nil && (state == "not-applicable" || state == "unassigned" || state != "unavailable" && account == nil)) {
		return unavailable()
	}
	out["aiAccountId"], out["bindingState"], out["aiAccount"] = id, state, account
	return Object{"state": "recorded", "operationId": row["id"], "operatorId": row["operator_id"], "kind": row["kind"], "selection": selection, "result": Object{"automation": out, "operationId": row["id"], "recordedAt": stamp(row["created_at"]), "replayed": true}}, nil
}

// ExecutionIntersection reports only the original grant/person permission
// intersection. It neither mints an executor nor declares jobs connected.
func (s *Service) ExecutionIntersection(ctx context.Context, tx pgx.Tx, grantID string, person *Actor, actions, resourceIDs []string) (Object, error) {
	grant, e := one(ctx, tx, "SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 AND id=$2", s.Endpoint, grantID)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && grant["enabled"] != true {
		return nil, fail("operations_automation_denied", 403)
	}
	if e != nil {
		return nil, e
	}
	for _, a := range actions {
		if !known(a) {
			return nil, fail("operations_permission_unknown", 403)
		}
	}
	scope := automationScope(grant)
	if scope["kind"] == "unresolved" || !idsOK(arrayOf(resourceIDs), 100, false) || len(actions) > 0 && len(resourceIDs) == 0 {
		return nil, fail("operations_automation_scope_denied", 403)
	}
	if scope["kind"] == "selected" {
		for _, id := range resourceIDs {
			if !contains(stringsOf(scope["resourceIds"]), id) {
				return nil, fail("operations_automation_scope_denied", 403)
			}
		}
	}
	if scope["kind"] == "eligible" {
		for _, a := range actions {
			if !operationsai.Autonomous(a) {
				return nil, fail("operations_automation_scope_denied", 403)
			}
		}
	}
	allowed := stringsOf(grant["permissions"])
	if grant["mode"] == "assisted" {
		if person == nil {
			return nil, fail("operations_automation_person_required", 403)
		}
		if s.Authority == nil {
			return nil, fail("operations_authorization_unavailable", 503)
		}
		current, e := s.Authority.EffectiveWithin(ctx, tx, *person)
		if e != nil {
			return nil, e
		}
		if current.ID != person.ID || current.Endpoint != s.Endpoint {
			return nil, fail("business_admin_denied", 403)
		}
		p := []string{}
		for _, a := range allowed {
			if contains(current.Permissions, a) {
				p = append(p, a)
			}
		}
		allowed = p
	}
	out := []string{}
	for _, a := range allowed {
		if !contains(actions, a) {
			continue
		}
		human := false
		for _, v := range catalogItems() {
			item := obj(v)
			if item["code"] == a && item["humanOnly"] == true {
				human = true
				break
			}
		}
		if !human {
			out = append(out, a)
		}
	}
	return Object{"permissions": arrayOf(out), "executionAvailable": false, "state": "not-connected", "grantVersion": grant["version"], "resourceScope": scope}, nil
}
