package businessadmin

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// OperationRecordWithin preserves the original missing-ledger unknown result
// while allowing the caller's final current-authority check to run in this tx.
// It does not grant receipt ownership or project an arbitrary stored result.
func (d *Domain) OperationRecordWithin(ctx context.Context, tx pgx.Tx, operation string) (Object, bool, error) {
	if _, e := tx.Exec(ctx, "SAVEPOINT operations_receipt"); e != nil {
		return nil, false, e
	}
	r, e := one(ctx, tx, "SELECT to_jsonb(a) FROM business_admin_audit_v1 a WHERE endpoint=$1 AND operation_id=$2", d.Endpoint, operation)
	if e != nil {
		if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT operations_receipt"); err != nil {
			return nil, false, err
		}
		if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT operations_receipt"); err != nil {
			return nil, false, err
		}
		var pg *pgconn.PgError
		if errors.As(e, &pg) && pg.Code == "42P01" {
			return nil, true, nil
		}
		return nil, false, fail("operations_command_receipt_unavailable", 503)
	}
	_, e = tx.Exec(ctx, "RELEASE SAVEPOINT operations_receipt")
	return r, false, e
}
