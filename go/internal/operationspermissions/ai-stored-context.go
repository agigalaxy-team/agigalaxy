package operationspermissions

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// A storedHumanProof can be minted only by the configured current-person
// resolver. It is not a portal Cookie, private-service token, or JSON actor.
type storedHumanProof struct {
	owner                *Service
	operatorID, endpoint string
}

func (s *Service) storedHuman(ctx context.Context, tx pgx.Tx, actor Actor) (Actor, error) {
	proof, ok := actor.Proof.(*storedHumanProof)
	if !ok || proof == nil || proof.owner != s || proof.operatorID != actor.ID || proof.endpoint != s.Endpoint || actor.Endpoint != s.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	if s.StoredAuthority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	fresh, e := s.StoredAuthority.PersonWithin(ctx, tx, proof.operatorID, false)
	if e != nil {
		return Actor{}, e
	}
	if fresh.ID != proof.operatorID || fresh.Endpoint != s.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	fresh.Proof = proof
	fresh.RequestID = actor.RequestID
	return fresh, nil
}
func (s *Service) effectiveHuman(ctx context.Context, tx pgx.Tx, actor Actor) (Actor, error) {
	if _, ok := actor.Proof.(*storedHumanProof); ok {
		return s.storedHuman(ctx, tx, actor)
	}
	if s.Authority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return s.Authority.EffectiveWithin(ctx, tx, actor)
}

// StoredHumanAIWithin is called only after the private caller has verified its
// durable conversation/task record and supplies that record's person/fixed AI.
// The service credential itself is never a source of the person's permissions.
func (s *Service) StoredHumanAIWithin(ctx context.Context, tx pgx.Tx, operatorID, domain, accountID, purpose, action string) (Actor, error) {
	if s.StoredAuthority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	actor := Actor{ID: operatorID, Endpoint: s.Endpoint, Proof: &storedHumanProof{s, operatorID, s.Endpoint}}
	fresh, e := s.storedHuman(ctx, tx, actor)
	if e != nil {
		return Actor{}, e
	}
	return s.HumanAIAccountWithin(ctx, tx, fresh, domain, accountID, purpose, action)
}
