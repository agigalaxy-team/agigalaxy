package operationspermissions

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// ManagementCapabilitiesWithin exposes capability facts only. Prompt text,
// credentials and policy bodies stay behind their separately checked readers.
func (s *Service) ManagementCapabilitiesWithin(ctx context.Context, tx pgx.Tx, actor Actor) (Object, error) {
	identity, e := s.delegatedReadIdentitiesWithin(ctx, tx, actor)
	if e != nil {
		return nil, e
	}
	query, prepared, accountID := identity.query, identity.prepared, identity.accountID
	availability, row, e := s.delegatedAvailabilityForIdentity(ctx, tx, identity)
	if e != nil {
		return nil, e
	}
	// The original capability view also looks up the current source delegation
	// outside overview. Keep that lookup and its failure behavior unchanged.
	if identity.domain != "overview" {
		row, e = s.delegationCurrent(ctx, tx, accountID)
		if e != nil {
			return nil, e
		}
	}
	targets := []any{}
	if availability["canReadRoles"] == true || availability["canReadPrompts"] == true {
		for _, id := range stringsOf(availability["targetAiAccountIds"]) {
			a, e := s.aiAccount(ctx, tx, id)
			if e != nil {
				return nil, e
			}
			targets = append(targets, a)
		}
	}
	active := availability["delegationId"] != nil
	fact := func(permission string, read, delegated, humanOnly, connected bool) Object {
		permissions := prepared.Permissions
		if read {
			permissions = query.Permissions
		}
		allowed := contains(permissions, permission)
		support := "connected"
		if humanOnly {
			support = "human-only"
		} else if !connected {
			support = "not-connected"
		}
		reasons := []string{}
		if !allowed {
			reasons = append(reasons, "permission-missing")
		}
		if !delegated {
			reasons = append(reasons, "delegation-missing")
		}
		if !connected && !humanOnly {
			reasons = append(reasons, "handler-not-connected")
		}
		if humanOnly {
			reasons = append(reasons, "human-only")
		}
		confirmation := "operation-card"
		if humanOnly {
			confirmation = "human-console"
		} else if read {
			confirmation = "read-tool"
		}
		return Object{"permission": permission, "systemSupport": support, "permissionAllowed": allowed, "delegated": delegated, "available": allowed && delegated && connected && !humanOnly, "confirmation": confirmation, "reasons": arrayOf(reasons)}
	}
	allowed := stringsOf(row["allowed_management_actions"])
	role := Object{"read": fact("ai.roles.read", true, active && contains(allowed, "read"), false, true)}
	for _, action := range []string{"create", "update", "assign", "revoke"} {
		role[action] = fact("ai.roles."+action, false, active && contains(allowed, action), false, true)
	}
	prompt := Object{"scope": "role-work-requirements", "read": fact("ai.prompts.read", true, active && contains(allowed, "prompt-read"), false, true), "update": fact("ai.prompts.update", false, active && contains(allowed, "prompt-update"), false, true)}
	ready := func(p string) bool {
		return s.AIWork != nil && s.AIWork.HandlerReady != nil && s.AIWork.HandlerReady(p)
	}
	ordinary := Object{"configure": fact("strategies.ordinary.configure", false, true, false, ready("strategies.ordinary.configure")), "publish": fact("strategies.ordinary.publish", false, true, false, ready("strategies.ordinary.publish"))}
	requireRead := func(write, read Object) {
		write["available"] = write["available"] == true && read["available"] == true
		if read["available"] != true {
			reasons := stringsOf(write["reasons"])
			for _, r := range stringsOf(read["reasons"]) {
				if !contains(reasons, r) {
					reasons = append(reasons, r)
				}
			}
			write["reasons"] = arrayOf(reasons)
		}
	}
	requireRead(obj(prompt["update"]), obj(prompt["read"]))
	for _, action := range []string{"create", "update", "assign", "revoke"} {
		requireRead(obj(role[action]), obj(role["read"]))
	}
	strategyRead := fact("strategies.read", true, true, false, true)
	for _, action := range []string{"configure", "publish"} {
		requireRead(obj(ordinary[action]), strategyRead)
	}
	return Object{"schemaVersion": 1, "sourceAiAccountId": accountID, "delegation": Object{"id": availability["delegationId"], "version": availability["version"], "enabled": active}, "targetAiAccounts": targets, "role": role, "prompt": prompt, "ordinaryStrategy": ordinary, "modelConfiguration": fact("models.configure", false, true, true, true), "authorityBoundaries": fact("ai.delegation.configure", false, true, true, true)}, nil
}
