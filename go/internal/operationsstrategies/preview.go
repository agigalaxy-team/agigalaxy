package operationsstrategies

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

func findStrategy(c Object, id any) Object {
	for _, v := range list(c["strategies"]) {
		if obj(v)["id"] == id {
			return obj(v)
		}
	}
	return nil
}
func (s *Service) PreviewWithin(ctx context.Context, tx pgx.Tx, configuration Object, strategyID string, a Actor) (Object, error) {
	strategy := findStrategy(configuration, strategyID)
	x := obj(strategy["execution"])
	checks, objects, grants := []any{}, []any{}, []any{}
	check := func(k string, v any, detail any) bool {
		state := "unknown"
		if v == true {
			state = "pass"
		} else if v == false {
			state = "fail"
		}
		checks = append(checks, Object{"key": k, "state": state, "detail": detail})
		return v == true
	}
	if !check("execution-configured", x != nil, nil) {
		return Object{"valid": false, "checks": checks, "objects": objects, "grants": grants, "sideEffects": false, "modelCalls": 0}, nil
	}
	var role *operationsai.Authorization
	if s.Autonomy != nil && s.Autonomy.AIWork != nil {
		r, e := s.Autonomy.AIWork.AuthorizationWithin(ctx, tx, str(x["aiDomain"]), nil)
		if e == nil {
			role = &r
		}
	}
	check("ai-account-enabled", role != nil && role.Enabled, nil)
	check("current-role", role != nil && len(role.Permissions) > 0, nil)
	domainObjective := any(nil)
	for _, v := range list(configuration["domains"]) {
		if obj(v)["key"] == strategy["domain"] {
			domainObjective = obj(v)["objective"]
		}
	}
	check("purpose-defined", strategy["objective"] != nil && obj(configuration["common"])["objective"] != nil && domainObjective != nil, nil)
	scope := obj(x["resourceScope"])
	check("scope-resolved", scope["kind"] != "unresolved" && (scope["kind"] != "selected" || len(list(scope["resourceIds"])) > 0), nil)
	trigger := obj(x["trigger"])
	check("trigger-configured", trigger["kind"] == "manual" || trigger["kind"] == "interval" && integer(trigger["minutes"], -9007199254740991, 9007199254740991) || trigger["kind"] == "daily" && str(trigger["at"]) != "" || trigger["kind"] == "event" && len(list(trigger["eventTypes"])) > 0, nil)
	check("code-judgment", x["mode"] != "code" || strategy["judgment"] != "semantic", nil)
	rows, e := tx.Query(ctx, `SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 AND id=ANY($2::uuid[])`, s.Endpoint, texts(x["grantIds"]))
	if e != nil {
		return nil, e
	}
	grantRows := []Object{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			rows.Close()
			return nil, e
		}
		o, e := decode(raw)
		if e != nil {
			rows.Close()
			return nil, e
		}
		grantRows = append(grantRows, o)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	automatic := has([]string{"code", "ai"}, str(x["mode"]))
	for _, code := range texts(x["actions"]) {
		definition := operationsai.Definition(code)
		check("role:"+code, role != nil && has(role.Permissions, code), nil)
		ready := false
		if s.ActionReady != nil {
			ready = s.ActionReady(code, str(x["mode"]))
		} else if s.Autonomy != nil && s.Autonomy.ActionReady != nil {
			ready = s.Autonomy.ActionReady(code)
		}
		check("handler:"+code, ready, nil)
		if automatic {
			check("ordinary-action:"+code, definition["autonomous"] == true && definition["humanOnly"] != true, nil)
			var grant Object
			for _, r := range grantRows {
				rs := p.AutomationResourceScope(r)
				kind := "ai"
				if x["mode"] == "code" {
					kind = "program"
				}
				compatible := rs["kind"] == "eligible"
				if rs["kind"] == "selected" && scope["kind"] == "selected" {
					compatible = true
					for _, id := range texts(scope["resourceIds"]) {
						compatible = compatible && has(texts(rs["resourceIds"]), id)
					}
				}
				if r["enabled"] == true && r["mode"] == "automatic" && r["executor_kind"] == kind && (kind == "program" || role != nil && r["ai_account_id"] == role.AccountID) && has(texts(r["permissions"]), code) && compatible {
					grant = r
					break
				}
			}
			check("grant:"+code, grant != nil, nil)
			if grant != nil {
				exists := false
				for _, v := range grants {
					exists = exists || obj(v)["id"] == grant["id"]
				}
				if !exists {
					grants = append(grants, Object{"id": grant["id"], "version": grant["version"]})
				}
			}
		}
		read := str(definition["read"])
		if read == "" {
			continue
		}
		if _, e = s.domain().Fresh(ctx, tx, a, read); e != nil {
			check("preview-read:"+code, false, nil)
			continue
		}
		check("preview-read:"+code, true, nil)
		if scope["kind"] != "selected" {
			continue
		}
		ids := texts(scope["resourceIds"])
		for _, id := range ids {
			var source Object
			if s.PreviewObjectWithin == nil {
				source = Object{"available": false, "version": nil}
			} else {
				source, e = s.PreviewObjectWithin(ctx, tx, a, str(definition["kind"]), id)
				if e != nil {
					if !has([]string{"403", "404", "409", "410"}, statusString(fault.Status(e))) {
						return nil, e
					}
					source = Object{"available": false, "version": nil}
				}
			}
			o := Object{"action": code, "id": id}
			for k, v := range source {
				o[k] = v
			}
			objects = append(objects, o)
			check("source:"+code+":"+id, source["available"], nil)
		}
	}
	if x["requiredRehearsal"] == true && len(list(x["actions"])) > 0 && scope["kind"] == "selected" {
		found := false
		for _, v := range objects {
			found = found || obj(v)["available"] == true
		}
		check("concrete-sample", found, nil)
	}
	valid := true
	for _, v := range checks {
		valid = valid && obj(v)["state"] == "pass"
	}
	var account, version any
	if role != nil {
		account, version = role.AccountID, role.AuthorizationVersion
	}
	qualification := "current-selected-source"
	if scope["kind"] == "eligible" {
		qualification = "checked-before-each-action"
	}
	return Object{"valid": valid, "checks": checks, "objects": objects, "grants": grants, "aiAccountId": account, "authorizationVersion": version, "scope": scope, "qualification": qualification, "classification": "configuration-and-current-consumer", "semanticJudgment": "not-validated", "sideEffects": false, "modelCalls": 0}, nil
}
func statusString(i int) string {
	switch i {
	case 403:
		return "403"
	case 404:
		return "404"
	case 409:
		return "409"
	case 410:
		return "410"
	}
	return ""
}
