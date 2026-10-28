package access

import (
	"context"
	"errors"
	"net/url"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// StoredOperatorAuthority revalidates the original person recorded on a job.
// It is not an HTTP identity and cannot issue or borrow a portal session.
type StoredOperatorAuthority struct{ gateway *Gateway }

// StoredOperators exposes the existing server-side current-person reader.
// Its methods use recorded principals, never an HTTP session or its proof.
func (g *Gateway) StoredOperators() *StoredOperatorAuthority {
	return &StoredOperatorAuthority{gateway: g}
}

func LoadWorker(ctx context.Context, pool *pgxpool.Pool, endpoint, operationsFile string) (*StoredOperatorAuthority, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	var c operationsConfiguration
	var root rootConfiguration
	if e := protectedJSON(operationsFile, 16384, &c); e != nil {
		return nil, e
	}
	if e := protectedJSON(c.RootFile, 16384, &root); e != nil {
		return nil, e
	}
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || pool == nil || c.Version != 1 || root.Version != 1 || root.Endpoint != endpoint || root.Issuer != c.Issuer || root.Subject == "" || root.OperatorID != identity.Digest([]byte(root.Issuer+"\x00"+root.Subject)) {
		return nil, fault.New("server_configuration_invalid", 400)
	}
	var roles struct {
		Administrator string `json:"administrator"`
		Reader        string `json:"reader"`
	}
	if protocol.Decode(c.Roles, &roles) != nil || !rolePattern.MatchString(roles.Administrator) || !rolePattern.MatchString(roles.Reader) || roles.Administrator == roles.Reader {
		return nil, fault.New("server_configuration_invalid", 400)
	}
	var credential struct {
		Version  int    `json:"version"`
		ClientID string `json:"clientId"`
		Secret   string `json:"clientSecret"`
	}
	if e := protectedJSON(c.CredentialFile, 16384, &credential); e != nil {
		return nil, e
	}
	if credential.Version != 1 {
		return nil, fault.New("server_configuration_invalid", 400)
	}
	directory, e := NewKeycloakDirectory(KeycloakConfig{Issuer: c.Issuer, AdminOrigin: c.DirectoryOrigin, ClientID: credential.ClientID, ClientSecret: credential.Secret})
	if e != nil {
		return nil, e
	}
	return &StoredOperatorAuthority{gateway: &Gateway{Pool: pool, Directory: directory, Config: Config{Endpoint: endpoint, OperatorIssuer: c.Issuer, AdministratorRole: roles.Administrator, ReaderRole: roles.Reader, Root: &Root{root.OperatorID, root.Issuer, root.Subject}}}}, nil
}

func (a *StoredOperatorAuthority) Revalidate(ctx context.Context, tx pgx.Tx, operatorID, action string) error {
	if a == nil || a.gateway == nil || tx == nil || !scopePattern.MatchString(operatorID) {
		return fault.New("business_admin_denied", 403)
	}
	if !knownPermission(action) {
		return fault.New("operations_permission_unknown", 403)
	}
	r, e := a.principalWithin(ctx, tx, operatorID)
	if e != nil {
		return e
	}
	_, e = a.gateway.authorize(ctx, tx, r, action)
	return e
}

// PersonWithin reads the recorded approver through the same current gateway
// authority as publication revalidation. It cannot create a browser identity.
func (a *StoredOperatorAuthority) PersonWithin(ctx context.Context, tx pgx.Tx, operatorID string, includeEligibility bool) (operationspermissions.Actor, error) {
	if _, e := a.principalWithin(ctx, tx, operatorID); e != nil {
		return operationspermissions.Actor{}, e
	}
	return a.gateway.PersonWithin(ctx, tx, operatorID, includeEligibility)
}

func (a *StoredOperatorAuthority) principalWithin(ctx context.Context, tx pgx.Tx, operatorID string) (session, error) {
	if a == nil || a.gateway == nil || tx == nil || !scopePattern.MatchString(operatorID) {
		return session{}, fault.New("business_admin_denied", 403)
	}
	g := a.gateway
	r := session{ID: operatorID}
	e := tx.QueryRow(ctx, "SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2", g.Config.Endpoint, operatorID).Scan(&r.Issuer, &r.Subject)
	if errors.Is(e, pgx.ErrNoRows) {
		return r, fault.New("business_admin_denied", 403)
	}
	if e != nil {
		return r, e
	}
	if r.Issuer != g.Config.OperatorIssuer || operatorID != identity.Digest([]byte(r.Issuer+"\x00"+r.Subject)) {
		return r, fault.New("business_admin_denied", 403)
	}
	return r, nil
}
