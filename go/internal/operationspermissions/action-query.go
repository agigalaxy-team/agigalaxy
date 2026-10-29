package operationspermissions

import (
	"context"
	"math"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) AIWorkContext(actor Actor) (Object, error) {
	c, e := s.humanContext(actor)
	if e != nil {
		return nil, e
	}
	return Object{"domain": c.domain, "accountId": c.accountID, "purpose": c.purpose}, nil
}

// HumanAIAccountWithin pins an already persisted conversation's fixed position
// identity. It never substitutes a new account created for the same domain.
func (s *Service) HumanAIAccountWithin(ctx context.Context, tx pgx.Tx, actor Actor, domain, accountID, purpose, action string) (Actor, error) {
	if !validUUID(accountID) {
		return Actor{}, fail("operations_agentos_ai_use_denied", 403)
	}
	if actor.AIProof != nil {
		c, e := s.humanContext(actor)
		if e != nil {
			return Actor{}, e
		}
		if c.accountID != accountID {
			return Actor{}, fail("operations_agentos_ai_use_denied", 403)
		}
	} else {
		actor.AIProof = &aiContext{s, actor.ID, actor.Endpoint, domain, accountID, purpose, actor.Proof}
	}
	return s.HumanAIWithin(ctx, tx, actor, domain, purpose, action)
}

func queryProjection(value, spec any) any {
	switch shape := spec.(type) {
	case string:
		switch shape {
		case "s":
			v, ok := value.(string)
			if !ok {
				return nil
			}
			v = displaySlice(v, 4096)
			return v
		case "b":
			if v, ok := value.(bool); ok {
				return v
			}
			return nil
		case "n":
			switch v := value.(type) {
			case float64:
				if !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 {
					return v
				}
			case int:
				if v >= 0 {
					return v
				}
			case int64:
				if v >= 0 {
					return v
				}
			}
			return nil
		}
	case []any:
		a, ok := value.([]any)
		if !ok {
			return nil
		}
		if len(a) > 100 {
			a = a[:100]
		}
		out := []any{}
		for _, v := range a {
			out = append(out, queryProjection(v, shape[0]))
		}
		return out
	case map[string]any:
		o := obj(value)
		out := Object{}
		for k, s := range shape {
			out[k] = queryProjection(o[k], s)
		}
		return out
	}
	return nil
}
func managementDirectoryProjection(source Object) Object {
	return obj(queryProjection(source, Object{
		"delegation":       Object{"id": "s", "sourceAiAccountId": "s", "version": "n", "enabled": "b", "targetAiAccountIds": []any{"s"}, "grantablePermissions": []any{"s"}, "allowedManagementActions": []any{"s"}, "updatedAt": "s"},
		"targetAiAccounts": []any{Object{"id": "s", "domain": "s", "name": "s", "enabled": "b"}},
		"roles":            []any{Object{"id": "s", "name": "s", "description": "s", "subjectScope": "s", "managedAiAccountIds": []any{"s"}, "permissions": []any{"s"}, "enabled": "b", "version": "n", "usage": Object{"humanAssignments": "n", "aiAssignments": "n", "aiAccounts": []any{Object{"id": "s", "domain": "s", "name": "s", "enabled": "b"}}}, "impact": Object{"affectsPeople": "b", "affectsAi": "b", "assignmentCount": "n"}}},
		"assignments":      []any{Object{"id": "s", "aiAccountId": "s", "roleId": "s", "enabled": "b", "version": "n"}}, "availability": Object{"canReadRoles": "b", "canReadPrompts": "b", "managementActions": []any{"s"}, "promptActions": []any{"s"}, "delegationId": "s", "version": "n", "targetAiAccountIds": []any{"s"}},
	}))
}
func (s *Service) ReadManagementTool(ctx context.Context, operator Actor, domain string, input Object) (Object, error) {
	if !contains(operationsai.Domains, domain) {
		return nil, fail("invalid_operations_agentos_query", 400)
	}
	if !exact(input, nil, []string{"aiAccountId"}) {
		return nil, fail("invalid_operations_agentos_query", 400)
	}
	if v, ok := input["aiAccountId"]; ok && !validUUID(v) {
		return nil, fail("invalid_operations_agentos_query", 400)
	}
	actor, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
		return s.HumanAIReadWithin(ctx, tx, operator, domain, "query", "workbench.read")
	})
	if e != nil {
		return nil, e
	}
	var source, data Object
	action := "ai.roles.read"
	view := "delegation"
	if input["aiAccountId"] != nil {
		source, e = s.DelegatedPrompt(ctx, actor, input)
		if e != nil {
			return nil, e
		}
		prompt := obj(source["prompt"])
		if _, ok := prompt["name"].(string); !ok {
			return nil, fail("operations_query_response_invalid", 503)
		}
		if _, ok := prompt["text"].(string); !ok {
			return nil, fail("operations_query_response_invalid", 503)
		}
		if !exact(prompt, []string{"aiAccountId", "domain", "name", "configId", "revision", "promptVersion", "updatedAt", "text"}, nil) || !validUUID(prompt["aiAccountId"]) || !contains([]string{"governance", "messaging", "discovery", "maintenance"}, str(prompt["domain"])) || !validUUID(prompt["configId"]) || !intOK(prompt["revision"], 1) || !intOK(prompt["promptVersion"], 1) || utf8.RuneCountInString(str(prompt["name"])) > 100 || utf8.RuneCountInString(str(prompt["text"])) > 16000 {
			return nil, fail("operations_query_response_invalid", 503)
		}
		if _, e = time.Parse(time.RFC3339Nano, str(prompt["updatedAt"])); e != nil {
			return nil, fail("operations_query_response_invalid", 503)
		}
		data = Object{"prompt": prompt, "delegationVersion": source["delegationVersion"], "scope": "role-work-requirements", "instructionAuthority": "role-work-requirements-with-fixed-code-boundaries"}
		action, view = "ai.prompts.read", "role-work-requirements"
	} else {
		source, e = s.DelegatedDirectory(ctx, actor)
		if e != nil {
			return nil, e
		}
		data = managementDirectoryProjection(source)
		if obj(source["availability"])["canReadRoles"] != true {
			action = "ai.prompts.read"
		}
	}
	if _, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
		return s.HumanAIReadWithin(ctx, tx, actor, domain, "query", action)
	}); e != nil {
		return nil, e
	}
	now := s.now()
	deadline := now + 30
	if !intOK(source["readExpiresAt"], 0) {
		return nil, fail("operations_query_expired", 410)
	}
	if num(source["readExpiresAt"]) < deadline {
		deadline = num(source["readExpiresAt"])
	}
	if deadline <= now {
		return nil, fail("operations_query_expired", 410)
	}
	return Object{"tool": "read-ai-delegation", "module": "ai-management", "view": view, "availability": "available", "data": data, "evidenceRefs": []any{}, "pagination": Object{"next": nil, "complete": true}, "checkedAt": now, "readExpiresAt": deadline, "purpose": "ai-management", "excludedFromProfile": true}, nil
}
