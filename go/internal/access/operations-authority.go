package access

import (
	"context"
	"errors"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

var _ operationspermissions.Authority = (*Gateway)(nil)

// operationsProof is bound to a verified management cookie. Public actor fields
// and supplied permission snapshots cannot select another identity or authority.
type operationsProof struct {
	gateway  *Gateway
	hash, id string
}

func (g *Gateway) AuthorizeOperations(r *http.Request, write bool, action string) (operationspermissions.Actor, error) {
	s, e := g.authenticate(r, "operator", write)
	if e != nil {
		return operationspermissions.Actor{}, e
	}
	actor := operationspermissions.Actor{ID: s.ID, Endpoint: g.Config.Endpoint, Proof: &operationsProof{g, s.Hash, s.ID}}
	return postgres.InTx(r.Context(), g.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		if action == "" {
			return g.EffectiveWithin(r.Context(), tx, actor)
		}
		return g.RequireWithin(r.Context(), tx, actor, action)
	})
}
func (g *Gateway) operationsSession(ctx context.Context, tx pgx.Tx, actor operationspermissions.Actor) (session, error) {
	proof, ok := actor.Proof.(*operationsProof)
	if !ok || proof == nil || proof.gateway != g || proof.id != actor.ID || actor.Endpoint != g.Config.Endpoint {
		return session{}, fault.New("business_admin_denied", 403)
	}
	s, e := g.row(ctx, tx, "operator", proof.hash)
	if errors.Is(e, pgx.ErrNoRows) {
		return s, loginRequired("operator")
	}
	if e != nil {
		return s, e
	}
	if s.ID != proof.id || s.Issuer != g.Config.OperatorIssuer || s.ID != identity.Digest([]byte(s.Issuer+"\x00"+s.Subject)) {
		return s, fault.New("business_admin_denied", 403)
	}
	return s, nil
}
func (g *Gateway) EffectiveWithin(ctx context.Context, tx pgx.Tx, actor operationspermissions.Actor) (operationspermissions.Actor, error) {
	s, e := g.operationsSession(ctx, tx, actor)
	if e != nil {
		return operationspermissions.Actor{}, e
	}
	authority, e := g.effective(ctx, tx, s)
	if e != nil {
		return operationspermissions.Actor{}, e
	}
	actor.Role, actor.Version, actor.Permissions = authority.Role, authority.Version, append([]string{}, authority.Permissions...)
	return actor, nil
}
func (g *Gateway) RequireWithin(ctx context.Context, tx pgx.Tx, actor operationspermissions.Actor, action string) (operationspermissions.Actor, error) {
	if !knownPermission(action) {
		return operationspermissions.Actor{}, fault.New("operations_permission_unknown", 403)
	}
	fresh, e := g.EffectiveWithin(ctx, tx, actor)
	if e != nil {
		return fresh, e
	}
	if !contains(fresh.Permissions, action) {
		return fresh, fault.New("operations_permission_denied", 403)
	}
	return fresh, nil
}
func (g *Gateway) PersonWithin(ctx context.Context, tx pgx.Tx, id string, includeEligibility bool) (operationspermissions.Actor, error) {
	var s session
	s.ID = id
	e := tx.QueryRow(ctx, "SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2", g.Config.Endpoint, id).Scan(&s.Issuer, &s.Subject)
	if errors.Is(e, pgx.ErrNoRows) {
		return operationspermissions.Actor{}, fault.New("business_admin_denied", 403)
	}
	if e != nil {
		return operationspermissions.Actor{}, e
	}
	authority, e := g.effective(ctx, tx, s)
	if e != nil {
		return operationspermissions.Actor{}, e
	}
	actor := operationspermissions.Actor{ID: id, Endpoint: g.Config.Endpoint, Role: authority.Role, Version: authority.Version, Permissions: append([]string{}, authority.Permissions...), ManagementEligibility: "unknown"}
	if includeEligibility {
		if authority.Root {
			actor.ManagementEligibility = "qualified"
		} else if directory, ok := g.Directory.(freshDirectory); ok {
			names, e := directory.RolesFresh(ctx, s.Issuer, s.Subject)
			if e == nil {
				actor.ManagementEligibility = "unqualified"
				if contains(names, g.Config.AdministratorRole) {
					actor.ManagementEligibility = "qualified"
				}
			}
		}
	}
	return actor, nil
}
