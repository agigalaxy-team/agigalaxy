package access

import (
	"context"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

// LockOperationsPrincipalWithin pins the already authenticated human principal
// in the business transaction. It is not a role or AI-authority constructor.
func (g *Gateway) LockOperationsPrincipalWithin(ctx context.Context, tx pgx.Tx, actor operationspermissions.Actor) error {
	_, err := g.ReadOperationsPrincipalWithin(ctx, tx, actor)
	return err
}

// ReadOperationsPrincipalWithin returns only the already authenticated human's
// current issuer/subject metadata while holding the same principal row lock.
// It cannot construct an identity, role, cookie or delegated AI proof.
func (g *Gateway) ReadOperationsPrincipalWithin(ctx context.Context, tx pgx.Tx, actor operationspermissions.Actor) (map[string]string, error) {
	current, err := g.operationsSession(ctx, tx, actor)
	if err != nil {
		return nil, err
	}
	var issuer, subject string
	err = tx.QueryRow(ctx, "SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2 FOR SHARE", g.Config.Endpoint, current.ID).Scan(&issuer, &subject)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fault.New("business_admin_denied", 403)
	}
	if err != nil {
		return nil, err
	}
	if issuer != current.Issuer || subject != current.Subject {
		return nil, fault.New("business_admin_denied", 403)
	}
	return map[string]string{"issuer": issuer, "externalSubject": subject}, nil
}
