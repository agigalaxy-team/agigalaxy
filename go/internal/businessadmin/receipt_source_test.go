package businessadmin

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"testing"
)

func TestMissingOriginalLedgerRemainsUnknownAndTransactionUsable(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	d := &Domain{Endpoint: "https://isolated.example.invalid"}
	row, unknown, e := d.OperationRecordWithin(ctx, tx, uuid.NewString())
	if e != nil || !unknown || row != nil {
		t.Fatal("missing original ledger", unknown, e)
	}
	var one int
	if e = tx.QueryRow(ctx, "SELECT 1").Scan(&one); e != nil || one != 1 {
		t.Fatal("receipt load poisoned final authorization transaction", e)
	}
}
