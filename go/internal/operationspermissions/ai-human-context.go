package operationspermissions

import (
	"context"
	"reflect"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/jackc/pgx/v5"
)

// aiContext is an in-process restriction attached only after authenticating a
// human and checking the current position. JSON cannot reconstruct this proof.
type aiContext struct {
	owner                                            *Service
	operatorID, endpoint, domain, accountID, purpose string
	humanProof                                       any
}

func (s *Service) humanContext(a Actor) (*aiContext, error) {
	if a.AIProof == nil {
		return nil, fail("business_admin_denied", 403)
	}
	c, ok := a.AIProof.(*aiContext)
	if !ok || c == nil || c.owner != s || c.operatorID != a.ID || c.endpoint != a.Endpoint || !sameHumanProof(c.humanProof, a.Proof) {
		return nil, fail("operations_agentos_ai_use_denied", 403)
	}
	return c, nil
}
func (s *Service) HumanAIWithin(ctx context.Context, tx pgx.Tx, actor Actor, domain, purpose, action string) (Actor, error) {
	if s.AIWork == nil || s.Authority == nil && s.StoredAuthority == nil {
		return Actor{}, fail("operations_ai_work_unavailable", 503)
	}
	if !contains(operationsai.Domains, domain) || !contains([]string{"conversation", "query", "prepare", "execution"}, purpose) {
		return Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	original := actor
	var existing *aiContext
	if actor.AIProof != nil {
		c, e := s.humanContext(actor)
		if e != nil {
			return Actor{}, e
		}
		if c.domain != domain {
			return Actor{}, fail("operations_agentos_domain_mismatch", 403)
		}
		existing = c
	}
	base := actor
	base.AIProof = nil
	fresh, e := s.require(ctx, tx, base, "workbench.read")
	if e != nil {
		return Actor{}, e
	}
	fresh, e = s.require(ctx, tx, fresh, "ai.use."+domain)
	if e != nil {
		if fault.Code(e) == "operations_permission_denied" {
			return Actor{}, fail("operations_agentos_ai_use_denied", 403)
		}
		return Actor{}, e
	}
	var accountID *string
	if existing != nil {
		accountID = &existing.accountID
	}
	current, e := s.AIWork.AuthorizationWithin(ctx, tx, domain, accountID)
	if e != nil {
		return Actor{}, e
	}
	if !current.Enabled {
		return Actor{}, fail("operations_ai_work_disabled", 403)
	}
	fresh.AIProof = &aiContext{s, original.ID, s.Endpoint, domain, current.AccountID, purpose, original.Proof}
	return s.requireHumanAI(ctx, tx, fresh, action)
}
func (s *Service) requireHumanAI(ctx context.Context, tx pgx.Tx, actor Actor, action string) (Actor, error) {
	c, e := s.humanContext(actor)
	if e != nil {
		return Actor{}, e
	}
	if s.AIWork == nil || s.Authority == nil && s.StoredAuthority == nil {
		return Actor{}, fail("operations_ai_work_unavailable", 503)
	}
	base := actor
	base.AIProof = nil
	fresh, e := s.effectiveHuman(ctx, tx, base)
	if e != nil {
		return Actor{}, e
	}
	if fresh.ID != c.operatorID || fresh.Endpoint != s.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if !contains(fresh.Permissions, "ai.use."+c.domain) {
		return Actor{}, fail("operations_agentos_ai_use_denied", 403)
	}
	current, e := s.AIWork.AuthorizationWithin(ctx, tx, c.domain, &c.accountID)
	if e != nil {
		return Actor{}, e
	}
	if !current.Enabled {
		return Actor{}, fail("operations_ai_work_disabled", 403)
	}
	work := operationsai.WorkPermissions(c.purpose, current.Permissions)
	permissions := []string{}
	for _, p := range fresh.Permissions {
		if p == "workbench.read" || p == "ai.use."+c.domain || contains(work, p) {
			permissions = append(permissions, p)
		}
	}
	roles := []any{}
	if fresh.Role != "administrator" {
		rows, e := tx.Query(ctx, `SELECT a.id::text,a.version,a.enabled,r.id::text,r.version,r.enabled FROM operations_role_assignments_v1 a JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint WHERE a.endpoint=$1 AND a.operator_id=$2 AND a.enabled ORDER BY a.id`, s.Endpoint, fresh.ID)
		if e != nil {
			return Actor{}, e
		}
		for rows.Next() {
			var id, roleID string
			var version, roleVersion int64
			var enabled, roleEnabled bool
			if e = rows.Scan(&id, &version, &enabled, &roleID, &roleVersion, &roleEnabled); e != nil {
				rows.Close()
				return Actor{}, e
			}
			roles = append(roles, []any{id, version, enabled, roleID, roleVersion, roleEnabled})
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return Actor{}, e
		}
	}
	humanScope := struct {
		Endpoint   string `json:"endpoint"`
		OperatorID string `json:"operatorId"`
		Role       string `json:"role"`
		Roles      []any  `json:"roles"`
	}{s.Endpoint, fresh.ID, fresh.Role, roles}
	fresh.Version = "ai-work:" + identity.Digest([]byte(jsonText([]any{humanScope, current.AccountID, current.AuthorizationVersion, current.RoleVersions, c.purpose, permissions})))
	fresh.Permissions = permissions
	fresh.AIProof = c
	if !known(action) {
		return Actor{}, fail("operations_permission_unknown", 403)
	}
	if !contains(permissions, action) {
		return Actor{}, fail("operations_permission_denied", 403)
	}
	return fresh, nil
}

func sameHumanProof(a, b any) bool {
	t := reflect.TypeOf(a)
	return t != nil && t == reflect.TypeOf(b) && t.Comparable() && a == b
}
