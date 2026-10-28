package access

import (
	"context"
	"errors"
	"strconv"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

type AuthoritySnapshot struct {
	Version     string   `json:"version"`
	Permissions []string `json:"permissions"`
	Role        string   `json:"-"`
	Root        bool     `json:"-"`
}
type freshDirectory interface {
	RolesFresh(context.Context, string, string) ([]string, error)
}

func (g *Gateway) effective(ctx context.Context, tx pgx.Tx, r session) (AuthoritySnapshot, error) {
	var out AuthoritySnapshot
	allowed, e := g.admitted(ctx, tx, r)
	if e != nil {
		return out, e
	}
	if !allowed {
		return out, fault.New("business_admin_denied", 403)
	}
	var issuer, subject string
	// Authority changes are serialized below by the original advisory lock;
	// read-only publication workers must not require UPDATE on principals.
	e = tx.QueryRow(ctx, "SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2", g.Config.Endpoint, r.ID).Scan(&issuer, &subject)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && (issuer != r.Issuer || subject != r.Subject) {
		return out, fault.New("business_admin_denied", 403)
	}
	if e != nil {
		return out, e
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))", g.Config.Endpoint); e != nil {
		return out, e
	}
	var version int64
	e = tx.QueryRow(ctx, "SELECT version FROM operations_permission_authority_v1 WHERE endpoint=$1", g.Config.Endpoint).Scan(&version)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	out.Version = strconv.FormatInt(version, 10)
	root := g.Config.Root
	out.Root = root != nil && r.ID == root.OperatorID && r.Issuer == root.Issuer && r.Subject == root.Subject
	out.Role = "reader"
	out.Permissions = []string{}
	if out.Root {
		out.Role = "administrator"
		out.Permissions = append(out.Permissions, permissionCodes...)
		return out, nil
	}
	rows, e := tx.Query(ctx, `SELECT DISTINCT unnest(r.permissions) AS permission FROM operations_role_assignments_v1 a
	 JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint
	 WHERE a.endpoint=$1 AND a.operator_id=$2 AND a.enabled AND r.enabled ORDER BY permission`, g.Config.Endpoint, r.ID)
	if e != nil {
		return out, e
	}
	for rows.Next() {
		var p string
		if e = rows.Scan(&p); e != nil {
			rows.Close()
			return out, e
		}
		if knownPermission(p) {
			out.Permissions = append(out.Permissions, p)
		}
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return out, e
	}
	qualified := false
	needed := false
	for _, p := range out.Permissions {
		if contains(maintainerCodes, p) {
			needed = true
			break
		}
	}
	if needed {
		if fresh, ok := g.Directory.(freshDirectory); ok {
			roles, e := fresh.RolesFresh(ctx, r.Issuer, r.Subject)
			if e != nil {
				return out, fault.New("identity_directory_unavailable", 503)
			}
			qualified = contains(roles, g.Config.AdministratorRole)
		}
		if !qualified {
			kept := []string{}
			for _, p := range out.Permissions {
				if !contains(maintainerCodes, p) {
					kept = append(kept, p)
				}
			}
			out.Permissions = kept
		}
	}
	return out, nil
}
