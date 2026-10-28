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
	if permission != "feedback.read" && permission != "feedback.update" {
		return feedback.Operator{}, fault.New("operations_permission_unknown", 403)
	}
	allowed, e := g.admitted(ctx, tx, r)
	if e != nil {
		return feedback.Operator{}, e
	}
	if !allowed {
		return feedback.Operator{}, fault.New("business_admin_denied", 403)
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))", g.Config.Endpoint); e != nil {
		return feedback.Operator{}, e
	}
	root := g.Config.Root
	isRoot := root != nil && r.ID == root.OperatorID && r.Issuer == root.Issuer && r.Subject == root.Subject
	role := "reader"
	permissions := []string{}
	if isRoot {
		role = "administrator"
		permissions = []string{"feedback.read", "feedback.update"}
	} else {
		rows, e := tx.Query(ctx, `SELECT DISTINCT unnest(r.permissions) AS permission FROM operations_role_assignments_v1 a
		 JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint
		 WHERE a.endpoint=$1 AND a.operator_id=$2 AND a.enabled AND r.enabled`, g.Config.Endpoint, r.ID)
		if e != nil {
			return feedback.Operator{}, e
		}
		for rows.Next() {
			var p string
			if e = rows.Scan(&p); e != nil {
				rows.Close()
				return feedback.Operator{}, e
			}
			permissions = append(permissions, p)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return feedback.Operator{}, e
		}
	}
	if !contains(permissions, permission) {
		return feedback.Operator{}, fault.New("operations_permission_denied", 403)
	}
	return feedback.Operator{ID: r.ID, Role: role, CanManage: contains(permissions, "feedback.update")}, nil
}
