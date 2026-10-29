package operationspermissions

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// humanReadSnapshotAuthority is an explicit opt-in by the concrete human
// authority. Arbitrary Authority implementations retain their original checks.
// The returned projection includes a current workbench.read check.
type humanReadSnapshotAuthority interface {
	ReadHumanSnapshotWithin(context.Context, pgx.Tx, Actor) (Actor, error)
}

// HumanAIReadWithin takes one current human and fixed-AI projection inside this
// transaction for assembling a read response. It does not replace the separate
// fresh barrier required before the response is published, nor any action check.
func (s *Service) HumanAIReadWithin(ctx context.Context, tx pgx.Tx, actor Actor, domain, purpose, action string) (Actor, error) {
	if s.AIWork == nil || s.Authority == nil && s.StoredAuthority == nil {
		return Actor{}, fail("operations_ai_work_unavailable", 503)
	}
	if !contains(operationsai.Domains, domain) || !contains([]string{"conversation", "query", "prepare"}, purpose) {
		return Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	// A preparation-purpose card may include write permissions in its projected
	// actor, but this entry point can authorize only an actual read action.
	query := stringsOf(operationsai.Capabilities("", []string{action})["queryPermissions"])
	if action != "workbench.read" && action != "chat-reports.materials.read" && !contains(query, action) {
		return Actor{}, fail("operations_agentos_scope_denied", 403)
	}
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
	if base.Endpoint != s.Endpoint || base.ID == "" || protocol.TextLength(base.ID) > 1024 {
		return Actor{}, fail("business_admin_denied", 403)
	}
	var fresh Actor
	var err error
	if _, ok := base.Proof.(*storedHumanProof); ok {
		fresh, err = s.storedHuman(ctx, tx, base)
		if err == nil && !contains(fresh.Permissions, "workbench.read") {
			return Actor{}, fail("operations_permission_denied", 403)
		}
	} else if authority, ok := s.Authority.(humanReadSnapshotAuthority); ok {
		fresh, err = authority.ReadHumanSnapshotWithin(ctx, tx, base)
	} else {
		// Unknown authorities may apply restrictions beyond Permissions.
		return s.HumanAIWithin(ctx, tx, actor, domain, purpose, action)
	}
	if err != nil {
		return Actor{}, err
	}
	if fresh.ID != actor.ID || fresh.Endpoint != s.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if !contains(fresh.Permissions, "ai.use."+domain) {
		return Actor{}, fail("operations_agentos_ai_use_denied", 403)
	}
	var accountID *string
	if existing != nil {
		accountID = &existing.accountID
	}
	current, err := s.AIWork.AuthorizationWithin(ctx, tx, domain, accountID)
	if err != nil {
		return Actor{}, err
	}
	if !current.Enabled {
		return Actor{}, fail("operations_ai_work_disabled", 403)
	}
	c := &aiContext{s, actor.ID, s.Endpoint, domain, current.AccountID, purpose, actor.Proof}
	return s.projectHumanAI(ctx, tx, fresh, c, current, action)
}

// HumanAIAccountReadWithin preserves the fixed account of an already persisted
// conversation while building a read-only response.
func (s *Service) HumanAIAccountReadWithin(ctx context.Context, tx pgx.Tx, actor Actor, domain, accountID, purpose, action string) (Actor, error) {
	if !validUUID(accountID) {
		return Actor{}, fail("operations_agentos_ai_use_denied", 403)
	}
	if actor.AIProof != nil {
		c, err := s.humanContext(actor)
		if err != nil {
			return Actor{}, err
		}
		if c.accountID != accountID {
			return Actor{}, fail("operations_agentos_ai_use_denied", 403)
		}
	} else {
		actor.AIProof = &aiContext{s, actor.ID, actor.Endpoint, domain, accountID, purpose, actor.Proof}
	}
	return s.HumanAIReadWithin(ctx, tx, actor, domain, purpose, action)
}

// StoredHumanAIReadWithin is for a private reader that has verified the
// durable record binding this person and fixed AI account. The service
// credential itself supplies no human authority.
func (s *Service) StoredHumanAIReadWithin(ctx context.Context, tx pgx.Tx, operatorID, domain, accountID, purpose, action string) (Actor, error) {
	if s.StoredAuthority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	actor := Actor{ID: operatorID, Endpoint: s.Endpoint, Proof: &storedHumanProof{s, operatorID, s.Endpoint}}
	return s.HumanAIAccountReadWithin(ctx, tx, actor, domain, accountID, purpose, action)
}
