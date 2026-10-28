package access

import (
	"context"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/jackc/pgx/v5"
)

func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func (g *Gateway) admitted(ctx context.Context, db queryer, r session) (bool, error) {
	var issuer, subject string
	var blocked bool
	e := db.QueryRow(ctx, "SELECT issuer,external_subject,login_blocked OR deleted_at IS NOT NULL FROM operations_management_accounts_v1 WHERE endpoint=$1 AND operator_id=$2", g.Config.Endpoint, r.ID).Scan(&issuer, &subject, &blocked)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return false, e
	}
	if e == nil && (blocked || issuer != r.Issuer || subject != r.Subject) {
		return false, nil
	}
	if g.Directory == nil {
		return false, fault.New("operations_authorization_unavailable", 503)
	}
	names, e := g.Directory.Roles(ctx, r.Issuer, r.Subject)
	if e != nil {
		return false, fault.New("identity_directory_unavailable", 503)
	}
	if !contains(names, g.Config.AdministratorRole) && !contains(names, g.Config.ReaderRole) {
		return false, nil
	}
	return true, nil
}
func (g *Gateway) authorize(ctx context.Context, tx pgx.Tx, r session, permission string) (feedback.Operator, error) {
	if !knownPermission(permission) {
		return feedback.Operator{}, fault.New("operations_permission_unknown", 403)
	}
	current, e := g.effective(ctx, tx, r)
	if e != nil {
		return feedback.Operator{}, e
	}
	if !contains(current.Permissions, permission) {
		return feedback.Operator{}, fault.New("operations_permission_denied", 403)
	}
	return feedback.Operator{ID: r.ID, Role: current.Role, CanManage: contains(current.Permissions, "feedback.update")}, nil
}
